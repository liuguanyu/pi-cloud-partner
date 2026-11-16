/**
 * 云侧 WSS 传输层。
 *
 * 职责边界：只管「连接 + 帧」，不理解业务。重连、心跳、握手都在这里做完，
 * 上层只看到 online / offline / frame 三种回调。
 *
 * 为什么用 `ws` 而不是 Node 内置的全局 WebSocket：
 * 内置实现是 WHATWG 严格版，**不接受自定义请求头**，而 bridge 必须带
 * `Authorization: Device <token>`。`ws` 本身零依赖，且提供 headers / ping / 背压。
 *
 * 保活仍走应用层 `bridge.ping` 帧（而不是 WS ping）：它同时更新云端的 device.last_seen，
 * 且能穿过 nginx 与忽略 TCP keepalive 的中间设备。
 */
import WS from "ws";
import { envelope, PROTOCOL_VERSION, Up, type BridgeHello, type BridgeWelcome, type Envelope } from "./protocol.ts";

export type CloudStatus = "idle" | "connecting" | "online" | "offline";

export interface CloudClientOptions {
  /** 形如 wss://host/ws/bridge */
  url: string;
  deviceToken: string;
  deviceId: string;
  deviceName: string;
  workspaces: string[];
  maxRunning: number;
  getLiveChildren: () => number;
  /** 每次（重）连时取一次候选目录，用于 hello 帧 */
  getDirs?: () => Array<{ path: string; name: string; depth: number; isGit: boolean }>;
  /** 心跳间隔，默认 30s（实测链路空闲 130s 不断，留足余量） */
  heartbeatMs?: number;
  /** 握手超时 */
  handshakeTimeoutMs?: number;
  onFrame: (env: Envelope) => void;
  onStatus: (status: CloudStatus, detail?: string) => void;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class CloudClient {
  #opts: CloudClientOptions;
  #ws: WS | null = null;
  #status: CloudStatus = "idle";
  #stopped = false;
  #ready: Promise<BridgeWelcome> | null = null;
  #resolveReady: ((w: BridgeWelcome) => void) | null = null;
  #rejectReady: ((e: Error) => void) | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #attempt = 0;
  #welcome: BridgeWelcome | null = null;

  constructor(opts: CloudClientOptions) {
    this.#opts = opts;
  }

  get status(): CloudStatus {
    return this.#status;
  }

  get welcome(): BridgeWelcome | null {
    return this.#welcome;
  }

  /** 启动连接循环（不抛错；失败会退避重试）。 */
  start(): void {
    this.#stopped = false;
    void this.#loop();
  }

  /** 等待当前这一轮握手完成。 */
  async whenOnline(): Promise<BridgeWelcome> {
    if (this.#status === "online" && this.#welcome) return this.#welcome;
    if (!this.#ready) {
      this.#ready = new Promise<BridgeWelcome>((resolve, reject) => {
        this.#resolveReady = resolve;
        this.#rejectReady = reject;
      });
    }
    return this.#ready;
  }

  /** 发送一帧；离线时返回 false（不排队，避免内存里堆无法送达的指令）。 */
  send(env: Envelope): boolean {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WS.OPEN) {
      this.#log("发送失败：连接未就绪", { type: env.type });
      return false;
    }
    try {
      ws.send(JSON.stringify(env));
      return true;
    } catch (error) {
      this.#log("发送异常", { type: env.type, error: String(error) });
      return false;
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#clearHeartbeat();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.close(1000, "bridge shutting down");
      } catch {
        /* ignore */
      }
    }
    this.#setStatus("idle");
  }

  // ── 内部 ────────────────────────────────────────────────────

  #log(msg: string, data?: Record<string, unknown>): void {
    this.#opts.log?.(msg, data);
  }

  #setStatus(status: CloudStatus, detail?: string): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#opts.onStatus(status, detail);
  }

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#connectOnce();
      } catch (error) {
        this.#log("连接失败", { error: String(error) });
      }
      this.#clearHeartbeat();
      this.#ws = null;
      if (this.#stopped) break;
      this.#setStatus("offline");

      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** this.#attempt);
      const jitter = Math.floor(backoff * 0.2 * Math.random());
      this.#attempt += 1;
      this.#log("退避重连", { waitMs: backoff + jitter, attempt: this.#attempt });
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
    this.#setStatus("idle");
  }

  async #connectOnce(): Promise<void> {
    this.#setStatus("connecting");
    const ws = new WS(this.#opts.url, {
      headers: { Authorization: `Device ${this.#opts.deviceToken}` },
      handshakeTimeout: this.#opts.handshakeTimeoutMs ?? 10_000,
    });
    this.#ws = ws;

    const welcome = await new Promise<BridgeWelcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("握手超时")), this.#opts.handshakeTimeoutMs ?? 10_000);
      const cleanup = () => clearTimeout(timer);

      ws.on("open", () => {
        const hello: BridgeHello = {
          deviceId: this.#opts.deviceId,
          version: PROTOCOL_VERSION,
          workspaces: this.#opts.workspaces,
          ...(this.#opts.getDirs ? { dirs: this.#opts.getDirs() } : {}),
          name: this.#opts.deviceName,
          maxRunning: this.#opts.maxRunning,
          liveChildren: this.#opts.getLiveChildren(),
        };
        ws.send(JSON.stringify(envelope(Up.hello, { payload: hello })));
      });

      ws.on("message", (raw: WS.RawData) => {
        let env: Envelope;
        try {
          env = JSON.parse(String(raw)) as Envelope;
        } catch {
          return;
        }
        if (env.type === "bridge.welcome") {
          cleanup();
          resolve((env.payload ?? {}) as BridgeWelcome);
        }
      });

      ws.on("error", (error: Error) => {
        cleanup();
        reject(new Error(`WebSocket error: ${error.message}`));
      });

      ws.on("close", (code: number, reason: Buffer) => {
        cleanup();
        reject(new Error(`连接关闭 code=${code} ${reason.toString()}`.trim()));
      });
    });

    // 握手成功：切换到正式收帧模式
    this.#welcome = welcome;
    this.#attempt = 0;
    this.#ready = null;
    this.#resolveReady?.(welcome);
    this.#resolveReady = null;
    this.#rejectReady = null;
    this.#setStatus("online", `serverTime=${welcome.serverTime}`);

    ws.on("message", (raw: WS.RawData) => {
      let env: Envelope;
      try {
        env = JSON.parse(String(raw)) as Envelope;
      } catch {
        return;
      }
      if (env.type === "bridge.welcome") return;
      this.#opts.onFrame(env);
    });

    this.#startHeartbeat();

    // 阻塞到连接关闭，让 #loop 进入退避
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
    });
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    const interval = this.#opts.heartbeatMs ?? 30_000;
    this.#heartbeat = setInterval(() => {
      this.send(envelope(Up.ping));
    }, interval);
  }

  #clearHeartbeat(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }
}
