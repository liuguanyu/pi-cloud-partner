/**
 * HTTP 传输层（纯 TS）。
 *
 * 职责单一：拼请求、解响应、把服务端错误翻译成 ApiError。
 * **不认识状态、不发事件、不做重试** —— 重试与续传属于 sse.ts / bridge.ts。
 */
import type { Capacity, TaskSummary } from "@wire";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** 凭据失效（需要重新配对或重登） */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
}

type Auth =
  | { kind: "device"; token: string }
  | { kind: "bearer"; token: string }
  | { kind: "none" };

export interface PairClaimResult {
  pairId: string;
  status: string;
  refreshToken: string;
  refreshExpiresAt: number;
}

export interface PairView {
  pairId: string;
  status: string;
  claimIp?: string;
  device?: { deviceId: string; name: string; online: boolean };
  user?: { userId: string; displayName: string };
}

export interface SessionResult {
  pairToken: string;
  expiresAt: number;
}

export interface WorkspacesResult {
  online: boolean;
  workspaces: string[];
  capacity?: Capacity;
}

export interface TaskStartInput {
  prompt: string;
  workspace: string;
  isolation?: "shared" | "worktree";
}

export interface TaskStartResult {
  taskId: string;
  title: string;
  status: string;
}

export class ApiClient {
  readonly #base: string;

  constructor(opts: ApiClientOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
  }

  // ── 配对 ──────────────────────────────────────────────────

  requestPairCode(deviceToken: string): Promise<{ code: string; expiresAt: number }> {
    return this.#json("POST", "/pair/request", { kind: "device", token: deviceToken }, {});
  }

  /**
   * 认领配对码。**不需要登录**（L1）：授权发生在 PC 侧的 approve。
   * claimantId 仅用于幂等与抢码判定。
   */
  claim(code: string, deviceName: string, claimantId: string): Promise<PairClaimResult> {
    return this.#json("POST", "/pair/claim", { kind: "none" }, { code, deviceName, claimantId });
  }

  /** 用 refreshToken 查自己这个 pair 的状态（等待批准时轮询用）。 */
  pairCurrent(refreshToken: string): Promise<{ pairs: PairView[] }> {
    return this.#json("GET", "/pair/current", { kind: "bearer", token: refreshToken }, undefined);
  }

  revokePair(refreshToken: string, pairId: string, reason?: string): Promise<{ status: string }> {
    return this.#json("POST", "/pair/revoke", { kind: "bearer", token: refreshToken }, { pairId, reason });
  }

  // ── 会话 ──────────────────────────────────────────────────

  session(refreshToken: string, pairId: string): Promise<SessionResult> {
    return this.#json("POST", "/api/session", { kind: "bearer", token: refreshToken }, { pairId });
  }

  // ── 任务 ──────────────────────────────────────────────────

  workspaces(pairToken: string, pairId: string): Promise<WorkspacesResult> {
    return this.#json("GET", `/api/workspaces?pairId=${encodeURIComponent(pairId)}`, { kind: "bearer", token: pairToken }, undefined);
  }

  tasks(pairToken: string, pairId: string): Promise<{ tasks: TaskSummary[] }> {
    return this.#json("GET", `/api/tasks?pairId=${encodeURIComponent(pairId)}`, { kind: "bearer", token: pairToken }, undefined);
  }

  startTask(pairToken: string, pairId: string, input: TaskStartInput): Promise<TaskStartResult> {
    return this.#json("POST", `/api/task/start?pairId=${encodeURIComponent(pairId)}`, { kind: "bearer", token: pairToken }, input);
  }

  inputTask(
    pairToken: string,
    pairId: string,
    taskId: string,
    text: string,
    mode: "steer" | "follow_up",
  ): Promise<{ status: string }> {
    return this.#json(
      "POST",
      `/api/task/${encodeURIComponent(taskId)}/input?pairId=${encodeURIComponent(pairId)}`,
      { kind: "bearer", token: pairToken },
      { text, mode },
    );
  }

  cancelTask(pairToken: string, pairId: string, taskId: string): Promise<{ status: string }> {
    return this.#json(
      "POST",
      `/api/task/${encodeURIComponent(taskId)}/cancel?pairId=${encodeURIComponent(pairId)}`,
      { kind: "bearer", token: pairToken },
      {},
    );
  }

  focusTask(pairToken: string, pairId: string, taskId: string): Promise<{ status: string }> {
    return this.#json("POST", `/api/task/focus?pairId=${encodeURIComponent(pairId)}`, { kind: "bearer", token: pairToken }, { taskId });
  }

  history(pairToken: string, pairId: string, taskId: string): Promise<{ status: string }> {
    return this.#json("POST", `/api/history?pairId=${encodeURIComponent(pairId)}`, { kind: "bearer", token: pairToken }, { taskId });
  }

  respondUi(
    pairToken: string,
    pairId: string,
    body: { requestId: string; confirmed?: boolean; value?: unknown; cancelled?: boolean },
  ): Promise<{ status: string }> {
    return this.#json("POST", `/api/ui/respond?pairId=${encodeURIComponent(pairId)}`, { kind: "bearer", token: pairToken }, body);
  }

  // ── 内部 ──────────────────────────────────────────────────

  async #json<T>(method: string, path: string, auth: Auth, body: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth.kind === "device") headers.Authorization = `Device ${auth.token}`;
    if (auth.kind === "bearer") headers.Authorization = `Bearer ${auth.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(this.#base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const payload = parsed as { error?: string; message?: string } | undefined;
      throw new ApiError(
        response.status,
        payload?.error ?? `http_${response.status}`,
        payload?.message ?? response.statusText,
      );
    }
    return (parsed ?? {}) as T;
  }
}
