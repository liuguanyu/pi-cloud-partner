/**
 * pi RPC 客户端（stdio JSONL）。
 *
 * 为什么不直接用包里导出的 `RpcClient`：
 *   1. 它的 `send` 是 private，发不出 `extension_ui_response` —— 远程审批就断了；
 *   2. 需要自己控制 stdin 背压、请求超时、UI 请求的超时兜底。
 *
 * 协议参考：pi docs/rpc.md、docs/rpc-commands.md、docs/rpc-extension-ui.md
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createJsonlReader } from "./framing.ts";

/** 需要回填响应的阻塞式对话框方法。 */
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
/** 只通知、不需要响应的 UI 方法。 */
export const FIRE_AND_FORGET_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

export interface PiRecord {
  type: string;
  [key: string]: unknown;
}

export interface UiRequest extends PiRecord {
  type: "extension_ui_request";
  id: string;
  method: string;
}

export function isUiRequest(rec: PiRecord): rec is UiRequest {
  return rec.type === "extension_ui_request" && typeof rec.id === "string";
}

export class PiCommandError extends Error {
  readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = "PiCommandError";
    this.command = command;
  }
}

export interface PiClientOptions {
  /** pi 的工作目录。**决定 project trust / settings / MCP**，进程生命周期内不可变。 */
  cwd: string;
  /** 追加 CLI 参数，例如 ["--no-session"] 或 ["-e", "/path/approval.ts"]。 */
  args?: string[];
  env?: Record<string, string>;
  /** 单条 RPC 命令的响应超时。 */
  requestTimeoutMs?: number;
  /** pi 可执行文件，默认走 PATH 里的 pi。 */
  bin?: string;
  onStderr?: (chunk: string) => void;
}

type Pending = {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT = 30_000;

export class PiClient {
  readonly #opts: PiClientOptions;
  #proc: ChildProcess | null = null;
  #pending = new Map<string, Pending>();
  #recordListeners = new Set<(rec: PiRecord) => void>();
  #uiListener: ((req: UiRequest) => void) | null = null;
  #seq = 0;
  #exited = false;
  #stderr = "";

  constructor(opts: PiClientOptions) {
    this.#opts = opts;
  }

  // ── 生命周期 ────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.#proc) throw new Error("PiClient 已启动");
    const bin = this.#opts.bin ?? process.env.PCP_PI_BIN ?? "pi";
    const args = ["--mode", "rpc", ...(this.#opts.args ?? [])];

    const proc = spawn(bin, args, {
      cwd: this.#opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.#opts.env },
    });
    this.#proc = proc;

    const reader = createJsonlReader({
      onRecord: (rec) => this.#dispatch(rec as PiRecord),
      onMalformed: (_err, raw) =>
        this.#emit({ type: "client.parse_error", raw: raw.slice(0, 200) }),
    });

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => reader.push(chunk));
    proc.stdout?.on("end", () => reader.flush());

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      this.#stderr += chunk;
      if (this.#stderr.length > 64_000) this.#stderr = this.#stderr.slice(-32_000);
      this.#opts.onStderr?.(chunk);
    });

    proc.on("exit", (code, signal) => {
      this.#exited = true;
      const reason = `pi 进程退出 (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        this.#pending.delete(id);
        p.reject(new Error(`${reason}；命令 ${p.command} 未完成`));
      }
      this.#emit({ type: "client.exit", code, signal, stderr: this.getStderr() });
    });

    // 启动是否成功：给一小段时间，若已退出则立刻失败（比等到第一条命令好排查）
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (this.#exited) {
      throw new Error(`pi 启动失败：${this.getStderr().trim() || "无 stderr 输出"}`);
    }
  }

  /** 关闭 stdin 请 pi 有序退出；超时后强杀。 */
  async stop(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    this.#proc = null;
    try {
      proc.stdin?.end();
    } catch {
      /* ignore */
    }
    const closed = await Promise.race([
      new Promise<boolean>((resolve) => proc.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (closed) return;
    proc.kill("SIGTERM");
    const graceful = await new Promise<boolean>((resolve) => {
      proc.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), 2_000);
    });
    if (!graceful) proc.kill("SIGKILL");
  }

  get running(): boolean {
    return this.#proc !== null && !this.#exited;
  }

  getStderr(): string {
    return this.#stderr;
  }

  // ── 事件订阅 ────────────────────────────────────────────────

  /** 订阅非 response、非 UI 的会话事件。返回取消函数。 */
  onRecord(listener: (rec: PiRecord) => void): () => void {
    this.#recordListeners.add(listener);
    return () => this.#recordListeners.delete(listener);
  }

  /**
   * 设置阻塞式 UI 请求的处理者。**未设置时自动取消**——否则 pi 会一直挂着。
   * 只接收 DIALOG_METHODS；fire-and-forget 方法走 onRecord。
   */
  onUiRequest(listener: ((req: UiRequest) => void) | null): void {
    this.#uiListener = listener;
  }

  // ── 命令 ────────────────────────────────────────────────────

  /** 发送任意 RPC 命令，返回 response 的 data（失败抛 PiCommandError）。 */
  async send(
    command: Record<string, unknown>,
    timeoutMs = this.#opts.requestTimeoutMs ?? DEFAULT_TIMEOUT,
  ): Promise<unknown> {
    const proc = this.#proc;
    if (!proc || this.#exited) throw new Error("pi 进程未运行");

    const id = typeof command.id === "string" ? command.id : `c${++this.#seq}`;
    const payload = { ...command, id };

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new PiCommandError(String(command.type), `命令超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { command: String(command.type), resolve, reject, timer });
    });

    this.#write(`${JSON.stringify(payload)}\n`).catch((error: Error) => {
      const p = this.#pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.#pending.delete(id);
        p.reject(error);
      }
    });

    return promise;
  }

  /** 回填 extension_ui_response。 */
  async respondUi(
    id: string,
    body: { value?: unknown; confirmed?: boolean; cancelled?: boolean },
  ): Promise<void> {
    const record: Record<string, unknown> = { type: "extension_ui_response", id };
    if (body.cancelled) record.cancelled = true;
    else if (body.confirmed !== undefined) record.confirmed = body.confirmed;
    else record.value = body.value ?? null;
    await this.#write(`${JSON.stringify(record)}\n`);
  }

  // ── 常用命令的类型化包装 ────────────────────────────────────

  async prompt(
    message: string,
    images?: unknown[],
    streamingBehavior?: "steer" | "followUp",
  ): Promise<{ disposition: string }> {
    const cmd: Record<string, unknown> = { type: "prompt", message };
    if (images?.length) cmd.images = images;
    if (streamingBehavior) cmd.streamingBehavior = streamingBehavior;
    return (await this.send(cmd, 120_000)) as { disposition: string };
  }

  async steer(message: string): Promise<unknown> {
    return this.send({ type: "steer", message });
  }

  async followUp(message: string): Promise<unknown> {
    return this.send({ type: "follow_up", message });
  }

  async abort(): Promise<unknown> {
    return this.send({ type: "abort" });
  }

  async getState(): Promise<Record<string, unknown>> {
    return (await this.send({ type: "get_state" })) as Record<string, unknown>;
  }

  async getSessionStats(): Promise<Record<string, unknown>> {
    return (await this.send({ type: "get_session_stats" })) as Record<string, unknown>;
  }

  async newSession(): Promise<{ cancelled: boolean }> {
    return (await this.send({ type: "new_session" })) as { cancelled: boolean };
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return (await this.send({ type: "switch_session", sessionPath })) as { cancelled: boolean };
  }

  async setSessionName(name: string): Promise<unknown> {
    return this.send({ type: "set_session_name", name });
  }

  async getTree(): Promise<Record<string, unknown>> {
    return (await this.send({ type: "get_tree" })) as Record<string, unknown>;
  }

  async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
    return (await this.send({ type: "get_fork_messages" })) as Array<{
      entryId: string;
      text: string;
    }>;
  }

  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    return (await this.send({ type: "fork", entryId })) as { text: string; cancelled: boolean };
  }

  async clone(): Promise<{ cancelled: boolean }> {
    return (await this.send({ type: "clone" })) as { cancelled: boolean };
  }

  async compact(instructions?: string): Promise<Record<string, unknown>> {
    const cmd: Record<string, unknown> = { type: "compact" };
    if (instructions) cmd.customInstructions = instructions;
    return (await this.send(cmd, 300_000)) as Record<string, unknown>;
  }

  async getAvailableModels(): Promise<Array<Record<string, unknown>>> {
    return (await this.send({ type: "get_available_models" })) as Array<Record<string, unknown>>;
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    return this.send({ type: "set_model", provider, modelId });
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    return (await this.send({ type: "get_available_thinking_levels" })) as string[];
  }

  async setThinkingLevel(level: string): Promise<unknown> {
    return this.send({ type: "set_thinking_level", level });
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const cmd: Record<string, unknown> = { type: "export_html" };
    if (outputPath) cmd.outputPath = outputPath;
    return (await this.send(cmd, 120_000)) as { path: string };
  }

  async bash(command: string): Promise<Record<string, unknown>> {
    return (await this.send({ type: "bash", command }, 300_000)) as Record<string, unknown>;
  }

  /** 可用的扩展命令 / skill / 提示模板。 */
  async getCommands(): Promise<Array<Record<string, unknown>>> {
    return (await this.send({ type: "get_commands" })) as Array<Record<string, unknown>>;
  }

  /** 等到 pi 不会再自动继续（agent_settled）。 */
  waitForIdle(timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`waitForIdle 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.onRecord((rec) => {
        if (rec.type === "agent_settled") {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
  }

  // ── 内部 ────────────────────────────────────────────────────

  #write(data: string): Promise<void> {
    const stdin = this.#proc?.stdin;
    if (!stdin) return Promise.reject(new Error("stdin 不可用"));
    return new Promise((resolve, reject) => {
      stdin.write(data, (error) => (error ? reject(error) : resolve()));
    });
  }

  #emit(rec: PiRecord): void {
    for (const listener of [...this.#recordListeners]) {
      try {
        listener(rec);
      } catch {
        /* 单个订阅者异常不影响其它订阅者与协议流 */
      }
    }
  }

  #dispatch(rec: PiRecord): void {
    if (rec.type === "response" && typeof rec.id === "string") {
      const pending = this.#pending.get(rec.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(rec.id);
        if (rec.success === false) {
          pending.reject(new PiCommandError(pending.command, String(rec.error ?? "未知错误")));
        } else {
          pending.resolve(rec.data ?? null);
        }
        return;
      }
    }

    if (isUiRequest(rec)) {
      const method = String(rec.method ?? "");
      if (DIALOG_METHODS.has(method)) {
        const listener = this.#uiListener;
        if (listener) {
          listener(rec);
        } else {
          // 没人接就立刻取消：让 pi 拿到 undefined/false 继续跑，而不是挂着等
          void this.respondUi(rec.id, { cancelled: true }).catch(() => {});
        }
        return;
      }
      if (FIRE_AND_FORGET_METHODS.has(method)) {
        // 无需回包，交给 onRecord 订阅者展示（状态栏 / 通知）
      }
    }

    this.#emit(rec);
  }
}
