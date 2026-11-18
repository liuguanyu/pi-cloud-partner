/**
 * SSE 传输层（纯 TS）。
 *
 * 职责单一：建立流、解析帧、断线重连。**不认识 task / approval 语义** ——
 * 它只把 Envelope 往上抛，语义解释在 store.ts。
 *
 * 为什么不用原生 EventSource：
 *   1. 它的 `Last-Event-ID` 只能带一个值，而我们是 per-task 游标；
 *   2. 无法自定义请求头（Authorization）；
 *   3. 自动重连策略不可控。
 * 所以用 fetch + ReadableStream 自己解析。
 */
import { isEnvelope, StreamHello, type Envelope, type StreamHelloPayload } from "@wire";

export type SseStatus = "idle" | "connecting" | "online" | "offline";

export interface SseClientOptions {
  url: string;
  /** 每次（重）连时读取最新 token —— pairToken 有 12h TTL，重连时必须现取，
   *  否则页面挂几小时后的重连会用过期 token 死循环。 */
  token: () => string;
  /** 握手收到 401：凭据问题，重试多少次都没用，上层必须换 token 后重建客户端 */
  onUnauthorized?: () => void;
  /** 每次（重）连时读取当前 per-task 游标，交给服务端回放缺口。 */
  cursors: () => Record<string, number>;
  onFrame: (env: Envelope) => void;
  onHello: (payload: StreamHelloPayload) => void;
  onStatus: (status: SseStatus, detail?: string) => void;
  log?: (msg: string) => void;
}

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 15_000;

export class SseClient {
  #opts: SseClientOptions;
  #stopped = false;
  #abort: AbortController | null = null;
  #attempt = 0;
  #status: SseStatus = "idle";

  constructor(opts: SseClientOptions) {
    this.#opts = opts;
  }

  get status(): SseStatus {
    return this.#status;
  }

  start(): void {
    this.#stopped = false;
    void this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    this.#abort?.abort();
    this.#abort = null;
    this.#setStatus("idle");
  }

  #setStatus(status: SseStatus, detail?: string): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#opts.onStatus(status, detail);
  }

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#connectOnce();
      } catch (error) {
        this.#opts.log?.(`SSE 断开: ${String(error)}`);
      }
      this.#abort = null;
      if (this.#stopped) break;
      this.#setStatus("offline");

      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** this.#attempt);
      this.#attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, backoff + Math.floor(backoff * 0.2 * Math.random())));
    }
    this.#setStatus("idle");
  }

  async #connectOnce(): Promise<void> {
    this.#setStatus("connecting");

    const url = new URL(this.#opts.url, location.origin);
    const cursors = this.#opts.cursors();
    if (Object.keys(cursors).length > 0) {
      url.searchParams.set("cursors", JSON.stringify(cursors));
    }

    const controller = new AbortController();
    this.#abort = controller;

    const token = this.#opts.token();
    if (!token) throw new Error("SSE 握手失败：没有可用凭据");
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      },
      signal: controller.signal,
      // 禁用缓存，避免中间层返回整段旧响应
      cache: "no-store",
    });

    if (response.status === 401) {
      this.#opts.onUnauthorized?.();
      throw new Error("SSE 握手 401：pairToken 已失效");
    }
    if (!response.ok || !response.body) {
      throw new Error(`SSE 握手失败 HTTP ${response.status}`);
    }

    this.#attempt = 0;
    this.#setStatus("online");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件块
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        this.#handleBlock(raw);
      }
    }
  }

  #handleBlock(raw: string): void {
    let eventName = "message";
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue; // 心跳注释
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trimStart();
    }
    if (!data) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return;
    }

    if (eventName === StreamHello) {
      this.#opts.onHello(parsed as StreamHelloPayload);
      return;
    }
    if (isEnvelope(parsed)) {
      // 个别实现里 event 名与 envelope.type 不一致，以 envelope 为准
      this.#opts.onFrame(parsed);
    }
  }
}
