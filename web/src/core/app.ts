/**
 * 组合根（纯 TS）：**唯一**同时知道 transport / storage / store 的地方。
 *
 * 其他模块都不知道彼此：
 *   api.ts    不知道 store
 *   sse.ts    不知道 task 语义
 *   store.ts  不发请求
 *   views     只调这里暴露的方法
 *
 * 换 UI 框架、换存储介质、甚至把 SSE 换成 WebSocket，都只需改这一层的接线。
 */
import { ApiClient, ApiError, type PairView } from "./api.ts";
import { CredentialStore, type StoredCredentials } from "./credential.ts";
import { SseClient, type SseStatus } from "./sse.ts";
import { TaskStore, type AppView } from "./store.ts";
import type { Capacity, UiRequestPayload } from "@wire";

/**
 * 阶段。注意**没有 need-token**：L1 起手机不需要登录，
 * 授权由 PC 侧 approve 完成（设备主人身份由云端在批准时代签）。
 */
export type Phase =
  | "booting"
  | "need-pair"
  | "waiting-approval"
  | "ready"
  | "error";

export interface AppState {
  phase: Phase;
  /** 首次同步是否完成。未完成时 UI 不应断言"离线"，否则首屏会闪错误状态。 */
  primed: boolean;
  error?: string;
  view: AppView;
  sseStatus: SseStatus;
  workspaces: string[];
  /** 白名单下可选的目录（含 git 标记） */
  dirs: Array<{ path: string; name: string; depth: number; isGit: boolean }>;
  bridgeOnline: boolean;
  capacity?: Capacity;
  pairs: PairView[];
  credentials: StoredCredentials;
}

export interface AppControllerOptions {
  baseUrl?: string;
  storage: Storage;
  now?: () => number;
}

const APPROVAL_POLL_MS = 2_000;
const APPROVAL_POLL_LIMIT_MS = 5 * 60_000;
const TASKS_REFRESH_MS = 30_000;

export class AppController {
  readonly store: TaskStore;
  readonly #api: ApiClient;
  readonly #creds: CredentialStore;
  readonly #now: () => number;

  /**
   * per-task 续传游标（仅页面生命周期内有效）。
   *
   * **不要持久化**：游标的前提是"客户端仍然持有对应状态"。
   * 刷新页面后 store 是空的，带着旧游标去连反而会让云端一条都不回放，
   * 表现为"刷新后历史全没了"。所以刷新时游标必须丢失，
   * 由云端「无游标 → 回放整个 ring」兜底。
   */
  #cursors: Record<string, number> = {};
  #bootId = "";

  #sse: SseClient | null = null;
  #phase: Phase = "booting";
  #primed = false;
  #error: string | undefined;
  #sseStatus: SseStatus = "idle";
  #workspaces: string[] = [];
  #dirs: Array<{ path: string; name: string; depth: number; isGit: boolean }> = [];
  #bridgeOnline = false;
  #capacity: Capacity | undefined;
  #pairs: PairView[] = [];
  #listeners = new Set<() => void>();
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #tasksTimer: ReturnType<typeof setInterval> | null = null;
  /** #recoverCredentials 的重入锁：401 会连发，只处理一次 */
  #recovering = false;

  constructor(opts: AppControllerOptions) {
    this.#api = new ApiClient({ baseUrl: opts.baseUrl ?? "" });
    this.#creds = new CredentialStore(opts.storage);
    this.#now = opts.now ?? (() => Date.now());
    this.store = new TaskStore();
    this.store.subscribe(() => this.#notify());
  }

  // ── 状态订阅 ────────────────────────────────────────────────

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  state(): AppState {
    const state: AppState = {
      phase: this.#phase,
      primed: this.#primed,
      view: this.store.snapshot(),
      sseStatus: this.#sseStatus,
      workspaces: this.#workspaces,
      dirs: this.#dirs,
      bridgeOnline: this.#bridgeOnline,
      pairs: this.#pairs,
      credentials: this.#creds.load(),
    };
    if (this.#error) state.error = this.#error;
    if (this.#capacity) state.capacity = this.#capacity;
    return state;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        /* ignore */
      }
    }
  }

  /** 认领者标识：持久化，保证弱网重试不会把自己当成"另一台手机"。 */
  #claimantId(): string {
    const existing = this.#creds.load().claimantId;
    if (existing) return existing;
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.#creds.patch({ claimantId: id });
    return id;
  }

  #setPhase(phase: Phase, error?: string): void {
    this.#phase = phase;
    this.#error = error;
    this.#notify();
  }

  // ── 启动 ────────────────────────────────────────────────────

  async bootstrap(): Promise<void> {
    this.#setPhase("booting");
    // localStorage 可能被 iOS 清掉：先尝试从 IndexedDB 自愈，
    // 成功的话用户完全无感（不用重新扫码）
    const restored = await this.#creds.restoreFromBackup();
    if (restored) {
      console.warn("[pcp] 凭据已从 IndexedDB 备份恢复");
    }
    const creds = this.#creds.load();
    if (!creds.pairId || !creds.refreshToken) {
      this.#setPhase("need-pair");
      return;
    }
    await this.#ensureReady();
  }

  /** 断开当前配对（凭据与本地缓存一起清掉，回到配对页）。 */
  async unpair(): Promise<void> {
    this.#stopSse();
    this.#stopApprovalPolling();
    this.#creds.patch({ pairId: undefined, refreshToken: undefined, pairToken: undefined });
    this.store.reset();
    this.#pairs = [];
    this.#workspaces = [];
    this.#dirs = [];
    this.#setPhase("need-pair");
  }

  // ── 配对 ────────────────────────────────────────────────────

  async claim(code: string, deviceName: string): Promise<void> {
    try {
      const result = await this.#api.claim(
        code.trim().toUpperCase(),
        deviceName || "phone",
        this.#claimantId(),
      );
      this.#creds.patch({ pairId: result.pairId, refreshToken: result.refreshToken });
      this.#setPhase("waiting-approval");
      this.#startApprovalPolling();
    } catch (error) {
      this.#setPhase("need-pair", describe(error));
    }
  }

  /** 轮询等待 PC 上的人点批准。批准不是云端做的，所以我们只能等。 */
  #startApprovalPolling(): void {
    this.#stopApprovalPolling();
    const began = this.#now();
    const tick = async (): Promise<void> => {
      const { refreshToken, pairId } = this.#creds.load();
      if (!refreshToken || !pairId) return;
      try {
        const { pairs } = await this.#api.pairCurrent(refreshToken);
        this.#pairs = pairs;
        const mine = pairs.find((p) => p.pairId === pairId);
        if (mine?.status === "active") {
          this.#stopApprovalPolling();
          await this.#ensureReady();
          return;
        }
        if (mine && (mine.status === "rejected" || mine.status === "revoked" || mine.status === "expired")) {
          this.#stopApprovalPolling();
          this.#creds.patch({ pairId: undefined, refreshToken: undefined, pairToken: undefined });
          this.#setPhase("need-pair", `配对${mine.status === "rejected" ? "被拒绝" : "已失效"}，请重新生成配对码`);
          return;
        }
      } catch (error) {
        if (error instanceof ApiError && error.isAuthFailure) {
          this.#stopApprovalPolling();
          this.#creds.patch({ pairId: undefined, refreshToken: undefined });
          this.#setPhase("need-pair", "配对凭据已失效，请重新配对");
          return;
        }
      }
      if (this.#now() - began > APPROVAL_POLL_LIMIT_MS) {
        this.#setPhase("need-pair", "等待批准超时，请重新生成配对码");
        return;
      }
      this.#pollTimer = setTimeout(() => void tick(), APPROVAL_POLL_MS);
    };
    void tick();
  }

  #stopApprovalPolling(): void {
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  // ── 就绪：换 token + 建流 ───────────────────────────────────

  async #ensureReady(): Promise<void> {
    const creds = this.#creds.load();
    if (!creds.pairId || !creds.refreshToken) {
      this.#setPhase("need-pair");
      return;
    }

    let pairToken = this.#creds.hasFreshPairToken(creds) ? creds.pairToken : undefined;
    if (!pairToken) {
      try {
        const session = await this.#api.session(creds.refreshToken, creds.pairId);
        pairToken = session.pairToken;
        this.#creds.patch({ pairToken: session.pairToken, pairTokenExpiresAt: session.expiresAt });
      } catch (error) {
        if (error instanceof ApiError && error.isAuthFailure) {
          this.#creds.patch({ pairId: undefined, refreshToken: undefined, pairToken: undefined });
          this.#setPhase("need-pair", "配对已失效，请重新配对");
          return;
        }
        this.#setPhase("error", describe(error));
        return;
      }
    }
    if (!pairToken) {
      this.#setPhase("error", "无法获取 pairToken");
      return;
    }

    this.#setPhase("ready");
    await this.#refreshWorkspaces(pairToken);
    await this.#refreshTasks(pairToken);
    this.#startSse(pairToken);
    this.#startTaskRefresh(pairToken);
  }

  #startSse(pairToken: string): void {
    this.#stopSse();
    const { pairId } = this.#creds.load();
    if (!pairId) return;

    this.#sse = new SseClient({
      url: `/sse?pairId=${encodeURIComponent(pairId)}`,
      // 现取 token：SSE 会随页面存活数小时，启动时的闭包值早就过期了
      token: () => {
        const c = this.#creds.load();
        return this.#creds.hasFreshPairToken(c) ? (c.pairToken ?? "") : "";
      },
      onUnauthorized: () => void this.#recoverCredentials(),
      cursors: () => this.#cursors,
      onFrame: (env) => {
        if (typeof env.seq === "number" && env.taskId && env.seq > (this.#cursors[env.taskId] ?? 0)) {
          this.#cursors[env.taskId] = env.seq;
        }
        this.store.ingest(env);
      },
      onHello: (payload) => {
        const boot = payload.bootId ?? "";
        if (boot && this.#bootId && boot !== this.#bootId) {
          // 云端重启过：seq 归零，旧游标全部失效，必须从头回放
          console.warn("[pcp] 云端已重启，丢弃本地游标并重新同步");
          this.#cursors = {};
          this.store.reset();
        }
        // 游标比服务端还新 → 说明服务端把这个 pair 的状态回收过（seq 归零），
        // 继续带旧游标只会得到"一条都不回放"的静默空白，必须丢弃重来。
        const maxCursor = Math.max(0, ...Object.values(this.#cursors));
        if (payload.lastSeq < maxCursor) {
          console.warn("[pcp] 服务端 seq 已重置，丢弃本地游标重新同步");
          this.#cursors = {};
          this.store.reset();
        }

        this.#bootId = boot || this.#bootId;
        this.store.ingestHello(payload);
        this.#bridgeOnline = payload.bridgeOn;
        this.#notify();
      },
      onStatus: (status) => {
        this.#sseStatus = status;
        this.#notify();
        // 流断了不代表配对坏了，退避重连由 SseClient 负责
      },
      log: (msg) => console.warn(msg),
    });
    this.#sse.start();
  }

  #stopSse(): void {
    this.#sse?.stop();
    this.#sse = null;
    this.#sseStatus = "idle";
    if (this.#tasksTimer) {
      clearInterval(this.#tasksTimer);
      this.#tasksTimer = null;
    }
  }

  /**
   * SSE 握手 401：pairToken 过期或被作废。
   * 用 refreshToken 换新的再重建流；refreshToken 也死了才回到配对页。
   * 页面在后台时 JS 被挂起，回来时 pairToken 几乎必然过期，这是主要恢复路径。
   */
  async #recoverCredentials(): Promise<void> {
    const creds = this.#creds.load();
    if (!creds.refreshToken || !creds.pairId) {
      this.#setPhase("need-pair", "配对已失效，请重新扫码");
      return;
    }
    // 防止 401 风暴：SseClient 内部还在退避重试，这里串行化处理
    if (this.#recovering) return;
    this.#recovering = true;
    try {
      const session = await this.#api.session(creds.refreshToken, creds.pairId);
      this.#creds.patch({ pairToken: session.pairToken, pairTokenExpiresAt: session.expiresAt });
      this.#stopSse();
      this.#startSse(session.pairToken);
      this.#startTaskRefresh(session.pairToken);
      this.#refreshWorkspaces(session.pairToken);
      this.#refreshTasks(session.pairToken);
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) {
        this.#creds.patch({ pairId: undefined, refreshToken: undefined, pairToken: undefined });
        this.#setPhase("need-pair", "配对已失效，请重新扫码");
      } else {
        // 网络问题：SseClient 的退避循环会带着新 token 继续试
      }
    } finally {
      this.#recovering = false;
    }
  }

  /**
   * 重新同步（幂等）。页面从后台恢复、SSE 重连成功后调用。
   *
   * 为什么必须显式做：iOS/微信 webview 把页面挂起时 JS 冻结、定时器停摆、
   * 网络断开，pairToken 可能正好在这期间过期。回来后不能只指望 30s 的
   * 定时刷新（它带着旧 token），要立刻拉一次最新列表 + 刷新 token。
   * 任务列表 API 现在是 device 锚定，这次拉取会把所有 pair 代的任务带回来。
   */
  async refresh(): Promise<void> {
    if (this.#phase !== "ready") return;
    const creds = this.#creds.load();
    if (!creds.refreshToken || !creds.pairId) return;
    let pairToken = this.#creds.hasFreshPairToken(creds) ? creds.pairToken : undefined;
    if (!pairToken) {
      try {
        const session = await this.#api.session(creds.refreshToken, creds.pairId);
        pairToken = session.pairToken;
        this.#creds.patch({ pairToken: session.pairToken, pairTokenExpiresAt: session.expiresAt });
      } catch {
        return; // 换 token 失败由 401 恢复 / 下次重试兜底
      }
    }
    if (!pairToken) return;
    // 并行拉：列表 + workspace 白名单
    await Promise.all([
      this.#refreshTasks(pairToken),
      this.#refreshWorkspaces(pairToken),
    ]);
    // 确保 SSE 在跑（若之前断了，重启它）
    if (this.#sse?.status !== "online" && this.#sse?.status !== "connecting") {
      this.#startSse(pairToken);
    }
  }

  #startTaskRefresh(pairToken: string): void {
    if (this.#tasksTimer) clearInterval(this.#tasksTimer);
    this.#tasksTimer = setInterval(() => void this.#refreshTasks(pairToken), TASKS_REFRESH_MS);
  }

  async #refreshWorkspaces(pairToken: string): Promise<void> {
    const { pairId } = this.#creds.load();
    if (!pairId) return;
    try {
      const result = await this.#api.workspaces(pairToken, pairId);
      this.#workspaces = result.workspaces;
      this.#dirs = result.dirs ?? [];
      this.#bridgeOnline = result.online;
      this.#capacity = result.capacity;
      this.#primed = true;
      this.#notify();
    } catch {
      // 拿不到就当作「已尝试过」：UI 可以显示离线，但不能一直停在"同步中"
      this.#primed = true;
      this.#notify();
    }
  }

  async #refreshTasks(pairToken: string): Promise<void> {
    const { pairId } = this.#creds.load();
    if (!pairId) return;
    try {
      const { tasks } = await this.#api.tasks(pairToken, pairId);
      this.store.mergeSummaries(tasks);
    } catch {
      /* 下次再试 */
    }
  }

  // ── 任务操作 ────────────────────────────────────────────────

  /** 上传附件，返回可放进 task.start 的引用。 */
  async upload(file: File): Promise<{ blobId: string; kind?: string; name?: string; mimeType?: string }> {
    const { pairToken, pairId } = this.#creds.load();
    if (!pairToken || !pairId) throw new Error("尚未就绪");
    const result = await this.#api.uploadBlob(pairToken, pairId, file);
    return {
      blobId: result.blobId,
      kind: result.kind,
      name: result.name,
      mimeType: result.mimeType,
    };
  }

  /** 把 blobId 换成可直接放进 <img src> 的签名链接（内部缓存）。 */
  async resolveBlobUrl(blobId: string, force = false): Promise<string> {
    const { pairToken, pairId } = this.#creds.load();
    if (!pairToken || !pairId) throw new Error("尚未就绪");
    return this.#api.blobUrl(pairToken, pairId, blobId, force);
  }

  async startTask(input: {
    prompt: string;
    workspace: string;
    isolation?: "shared" | "worktree";
    blobs?: Array<{ blobId: string; kind?: string; name?: string; mimeType?: string }>;
  }): Promise<string> {
    const { pairToken, pairId } = this.#creds.load();
    if (!pairToken || !pairId) throw new Error("尚未就绪");
    const result = await this.#api.startTask(pairToken, pairId, input);
    return result.taskId;
  }

  async steerTask(taskId: string, text: string, mode: "steer" | "follow_up" = "steer"): Promise<void> {
    const { pairToken, pairId } = this.#creds.load();
    if (!pairToken || !pairId) throw new Error("尚未就绪");
    await this.#api.inputTask(pairToken, pairId, taskId, text, mode);
    // 服务端已接受，立即上屏进插话队列。pi 的 queue_update 事件随后
    // 到达时会用权威列表整体替换（不会重复）；队列被消费时自动出队。
    if (mode === "steer") this.store.optimisticSteer(taskId, text);
  }

  async cancelTask(taskId: string): Promise<void> {
    const { pairToken, pairId } = this.#creds.load();
    if (!pairToken || !pairId) throw new Error("尚未就绪");
    await this.#api.cancelTask(pairToken, pairId, taskId);
  }

  /** 告诉 bridge 当前聚焦哪个任务，决定推全量 delta 还是只推摘要。 */
  async focusTask(taskId: string | null): Promise<void> {
    const { pairToken, pairId } = this.#creds.load();
    if (!pairToken || !pairId || !taskId) return;
    try {
      await this.#api.focusTask(pairToken, pairId, taskId);
    } catch {
      /* 非关键路径 */
    }
  }

  async answerApproval(approval: UiRequestPayload & { taskId: string }, decision: "approve" | "deny" | { value: unknown }): Promise<void> {
    const { pairToken, pairId } = this.#creds.load();
    if (!pairToken || !pairId) throw new Error("尚未就绪");

    const body: { requestId: string; confirmed?: boolean; value?: unknown; cancelled?: boolean } = {
      requestId: approval.requestId,
    };
    if (decision === "approve") body.confirmed = true;
    else if (decision === "deny") body.confirmed = false;
    else body.value = decision.value;

    await this.#api.respondUi(pairToken, pairId, body);
    this.store.clearApproval(approval.requestId);
  }

  async revokePair(): Promise<void> {
    const { refreshToken, pairId } = this.#creds.load();
    if (!pairId) return;
    try {
      if (refreshToken) await this.#api.revokePair(refreshToken, pairId, "user requested");
    } finally {
      this.#stopSse();
      this.#creds.patch({ pairId: undefined, refreshToken: undefined, pairToken: undefined });
      this.store.reset();
      this.#setPhase("need-pair");
    }
  }

  /**
   * 拉取任务历史。只在「本地没有完整内容」时调用：
   * 刷新后 / 隔天回来 / ring 已被云端丢弃的情况下，本地 blocks 是残缺或空的。
   */
  async loadHistory(taskId: string): Promise<void> {
    const { pairToken, pairId } = this.#creds.load();
    if (!pairToken || !pairId) return;
    const task = this.store.snapshot().byId[taskId];
    if (task?.historyLoaded) return;
    try {
      await this.#api.history(pairToken, pairId, taskId);
      // 应答走 SSE（history.data），不在这里等
    } catch (error) {
      if (error instanceof ApiError && error.code === "no_session") {
        // 老任务没有 sessionId（该字段是后加的），静默降级
        return;
      }
      throw error;
    }
  }

  async refreshWorkspaces(): Promise<void> {
    const { pairToken } = this.#creds.load();
    if (pairToken) await this.#refreshWorkspaces(pairToken);
  }

  dispose(): void {
    this.#stopSse();
    this.#stopApprovalPolling();
  }
}

/**
 * 把错误翻译成人话。
 * 不暴露内部错误码前缀（如 `unauthorized:`）—— 对用户没有信息量，只是噪音；
 * 只在没有 message 时才退回用 code。
 */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message || error.code;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
