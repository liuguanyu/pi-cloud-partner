/**
 * 任务执行器：把云下发的 task 变成真实的 pi 子进程执行。
 *
 * 并发模型（protocol/tasks.md §2）：
 *   - 一个 workspace 一个 pi 子进程，**同一 workspace 内串行**
 *   - 不同 workspace 可并行，受 maxRunning 限制
 *   - 空闲 child 到点回收（每个约 184MB RSS）
 *
 * 关键实现约束（都来自实测，别改回去）：
 *   1. cwd 在 spawn 时固定。跨目录必须重建子进程 —— switch_session 会让 cwd 变
 *      但 project trust / .pi/skills / settings / MCP 不会重新解析。
 *   2. project trust 必须显式传 --approve/--no-approve。RPC 模式下没人能回答弹窗，
 *      不传就会「静默不加载」项目级资源。
 *   3. 一个 child 同时只跑一个 run，因此 extension_ui_request 天然能归因到 taskId。
 */
import { basename } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { PiClient, isUiRequest, type PiRecord, type UiRequest } from "../pi/client.ts";
import { execControl, type ControlResult } from "../control/index.ts";
import { envelope, Up, type Envelope } from "./protocol.ts";

export interface RunnerOptions {
  workspaces: string[];
  maxRunning: number;
  maxLiveChildren: number;
  idleRecycleMs: number;
  model?: string;
  sessionDir?: string;
  /** 审批扩展路径；为空表示不加载（危险，仅调试） */
  approvalExtension?: string;
  /** deny = 不加载项目级资源（默认、安全）；approve = 加载 */
  projectTrust: "approve" | "deny";
  onUp: (env: Envelope) => void;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

export interface TaskRequest {
  taskId: string;
  /** 云端按 pair 路由事件；上行帧必须原样带回 */
  pairId: string;
  workspace: string;
  prompt: string;
  isolation: string;
  images?: unknown[];
}

type TaskState = "queued" | "running" | "awaiting_approval" | "settled" | "failed" | "cancelled";

interface HistoryRequest {
  taskId: string;
  sessionId: string;
  /** 回包必须带它：daemon 重启后本地已不知道旧任务属于哪个 pair，猜不出来 */
  pairId: string;
  /** 只取该时间点之后的消息（任务开始时间） */
  sinceMs?: number;
}

interface RunningTask {
  req: TaskRequest;
  workspace: string;
  child: Child;
  epoch: number;
  state: TaskState;
  lastLine: string;
  lastSummaryAt: number;
  settled: boolean;
}

interface Child {
  id: string;
  workspace: string;
  client: PiClient;
  task: RunningTask | null;
  lastUsedAt: number;
}

const SUMMARY_INTERVAL_MS = 1_000;

export class Runner {
  #opts: RunnerOptions;
  #queue: TaskRequest[] = [];
  #running = new Map<string, RunningTask>();
  #children = new Map<string, Child>();
  #childSeq = 0;
  #focusedTaskId: string | null = null;
  /** requestId → 发起它的 child 与**请求详情**（对账时要重发给手机） */
  #uiOwner = new Map<string, { child: Child; request: UiRequest }>();
  /** 最近一次见到的 pairId，用于给已结束任务补上行帧的归属 */
  #lastPairId: string | undefined;
  #settleWaiters = new Map<string, () => void>();
  #recycler: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(opts: RunnerOptions) {
    this.#opts = opts;
    this.#recycler = setInterval(() => void this.#recycleIdle(), 30_000);
  }

  // ── 对外接口 ────────────────────────────────────────────────

  submit(req: TaskRequest): { accepted: boolean; reason?: string } {
    if (!this.#workspaceAllowed(req.workspace)) {
      return { accepted: false, reason: "workspace_not_allowed" };
    }
    if (this.#queue.length >= 50) {
      return { accepted: false, reason: "queue_full" };
    }
    this.#queue.push(req);
    this.#emitCapacity();
    this.#pump();
    return { accepted: true };
  }

  input(taskId: string, text: string, mode: "steer" | "follow_up"): boolean {
    const task = this.#running.get(taskId);
    if (!task) return false;
    const client = task.child.client;
    void (async () => {
      try {
        if (mode === "steer") await client.steer(text);
        else await client.followUp(text);
      } catch (error) {
        this.#opts.log("输入投递失败", { taskId, mode, error: String(error) });
      }
    })();
    return true;
  }

  cancel(taskId: string): boolean {
    // 还没开始跑：直接从队列里摘掉
    const idx = this.#queue.findIndex((t) => t.taskId === taskId);
    if (idx >= 0) {
      this.#queue.splice(idx, 1);
      this.#up(
        envelope(Up.taskCancelled, {
          pairId: this.#queue[idx]?.pairId,
          taskId,
          payload: { exitReason: "queue_cancelled" },
        }),
      );
      this.#emitCapacity();
      return true;
    }
    const task = this.#running.get(taskId);
    if (!task) return false;
    void task.child.client.abort().catch(() => {});
    return true;
  }

  focus(taskId: string | null): void {
    this.#focusedTaskId = taskId;
  }

  /** 回填审批结果。requestId 是 pi 侧 extension_ui_request 的 id。 */
  respondUi(requestId: string, body: { value?: unknown; confirmed?: boolean; cancelled?: boolean }): boolean {
    const entry = this.#uiOwner.get(requestId);
    if (!entry) return false;
    this.#uiOwner.delete(requestId);
    const child = entry.child;
    void child.client.respondUi(requestId, body).catch(() => {});
    // 状态在本地切回 running，但**不再重发 task.started**：
    // 手机刚刚亲自点了批准，它知道任务在继续；重发会造成「开始」事件重复。
    const task = child.task;
    if (task) task.state = "running";
    return true;
  }

  /**
   * 读取某任务的历史正文。
   *
   * 云端不存正文，只存 sessionId；这里回到磁盘读 pi 写的 JSONL。
   * 所以即使 daemon 重启、云端 ring 清空，昨天的任务依然可回看。
   */
  async history(req: HistoryRequest): Promise<void> {
    const { loadSessionHistory } = await import("./history.ts");
    const result = await loadSessionHistory(req.sessionId, {
      sessionDir: this.#opts.sessionDir,
      sinceMs: req.sinceMs,
    });
    this.#opts.log("历史读取", {
      taskId: req.taskId,
      blocks: result.blocks.length,
      missing: Boolean(result.missing),
    });
    this.#opts.onUp(
      envelope(Up.historyData, {
        pairId: req.pairId || this.#pairIdFor(req.taskId),
        taskId: req.taskId,
        payload: {
          taskId: req.taskId,
          blocks: result.blocks,
          ...(result.missing ? { missing: true } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        },
      }),
    );
  }

  /** 历史请求可能针对已结束的任务，此时从「最近见过的任务」里找回 pairId。 */
  #pairIdFor(taskId: string): string | undefined {
    const running = this.#running.get(taskId);
    if (running) return running.req.pairId;
    return this.#lastPairId;
  }

  /** 处理控制面命令（/resume /new /fork …）。 */
  async control(name: string, args: string[], raw: string): Promise<ControlResult> {
    const child = this.#anyChild();
    if (!child) return { ok: false, text: "当前没有可用的 pi 子进程（先发一个任务）" };
    return execControl(
      {
        client: child.client,
        cwd: child.workspace,
        sessionDir: this.#opts.sessionDir,
        switchWorkspace: (newCwd: string) => this.#switchWorkspace(child, newCwd),
      },
      { name, args, rawArgs: raw },
    );
  }

  /**
   * 状态对账快照。
   *
   * 数据全部来自本进程已有的内存结构，不额外调用 pi —— 因为问题不是 pi 不知道，
   * 而是云端缓存因为事件断流而变旧。
   */
  snapshot(): {
    tasks: Array<{
      taskId: string;
      status: "running" | "queued" | "awaiting_approval";
      approval?: { requestId: string; method: string; title?: string; message?: string; options?: string[]; taskId: string };
    }>;
  } {
    const tasks: Array<{
      taskId: string;
      status: "running" | "queued" | "awaiting_approval";
      approval?: { requestId: string; method: string; title?: string; message?: string; options?: string[]; taskId: string };
    }> = [];

    for (const task of this.#running.values()) {
      const entry: (typeof tasks)[number] = {
        taskId: task.req.taskId,
        status: task.state === "awaiting_approval" ? "awaiting_approval" : "running",
      };
      if (task.state === "awaiting_approval") {
        const approval = [...this.#uiOwner.values()].find(
          (item) => item.child.task?.req.taskId === task.req.taskId,
        );
        if (approval) {
          const request = approval.request;
          entry.approval = {
            requestId: request.id,
            method: String(request.method ?? "confirm"),
            title: typeof request.title === "string" ? request.title : undefined,
            message: typeof request.message === "string" ? request.message : undefined,
            options: Array.isArray(request.options) ? (request.options as string[]) : undefined,
            taskId: task.req.taskId,
          };
        }
      }
      tasks.push(entry);
    }

    for (const queued of this.#queue) {
      if (!tasks.some((t) => t.taskId === queued.taskId)) {
        tasks.push({ taskId: queued.taskId, status: "queued" });
      }
    }
    return { tasks };
  }

  capacity(): {
    running: number;
    maxRunning: number;
    liveChildren: number;
    maxLiveChildren: number;
    queued: number;
  } {
    return {
      running: this.#running.size,
      maxRunning: this.#opts.maxRunning,
      liveChildren: this.#children.size,
      maxLiveChildren: this.#opts.maxLiveChildren,
      queued: this.#queue.length,
    };
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    if (this.#recycler) clearInterval(this.#recycler);
    const children = [...this.#children.values()];
    this.#children.clear();
    await Promise.allSettled(children.map((c) => c.client.stop()));
  }

  // ── 调度 ────────────────────────────────────────────────────

  #pump(): void {
    if (this.#closed) return;
    while (this.#running.size < this.#opts.maxRunning && this.#queue.length > 0) {
      // 同一 workspace 内串行：跳过正在被占用的 workspace
      const busy = new Set([...this.#running.values()].map((t) => t.workspace));
      const idx = this.#queue.findIndex((t) => !busy.has(t.workspace));
      if (idx < 0) return;
      const [req] = this.#queue.splice(idx, 1);
      if (!req) return;
      void this.#run(req);
    }
  }

  async #run(req: TaskRequest): Promise<void> {
    const workspace = this.#resolveWorkspace(req.workspace);
    let child: Child;
    try {
      child = await this.#ensureChild(workspace);
    } catch (error) {
      this.#opts.log("子进程启动失败", { taskId: req.taskId, error: String(error) });
      this.#up(
        envelope(Up.taskFailed, {
          pairId: req.pairId,
          taskId: req.taskId,
          payload: { exitReason: "spawn_failed", error: String(error) },
        }),
      );
      this.#pump();
      return;
    }

    this.#lastPairId = req.pairId;
    const task: RunningTask = {
      req,
      workspace,
      child,
      epoch: (child.task?.epoch ?? 0) + 1,
      state: "running",
      lastLine: "",
      lastSummaryAt: 0,
      settled: false,
    };
    child.task = task;
    child.lastUsedAt = Date.now();
    this.#running.set(req.taskId, task);

    // 新任务默认抢焦点：手机刚点的那个任务最可能想看
    if (!this.#focusedTaskId) this.#focusedTaskId = req.taskId;

    this.#emit(task, Up.taskStarted, this.#taskPayload(task));
    this.#emitCapacity();

    try {
      const state = await child.client.getState();
      // 把 sessionId 报给云端：历史回看要靠它定位磁盘上的 JSONL，
      // 且必须落库——否则 daemon 重启后就没法回看旧任务了。
      const sessionId = typeof state.sessionId === "string" ? state.sessionId : "";
      if (sessionId) {
        this.#emit(task, Up.taskStarted, { ...this.#taskPayload(task), sessionId });
      }
      const streaming = Boolean(state.isStreaming);
      const accepted = await child.client.prompt(
        req.prompt,
        req.images,
        streaming ? "followUp" : undefined,
      );
      this.#opts.log("任务已提交", { taskId: req.taskId, disposition: accepted.disposition, workspace });
      await this.#waitSettled(task);
    } catch (error) {
      task.state = "failed";
      this.#up(
        envelope(Up.taskFailed, {
          pairId: req.pairId,
          taskId: req.taskId,
          payload: { exitReason: "error", error: String(error) },
        }),
      );
    } finally {
      if (!task.settled) {
        // 保险：无论走哪条路径都要收尾，否则 running 计数泄漏
        this.#finish(task, task.state === "failed" ? "error" : "completed");
      }
    }
  }

  #waitSettled(task: RunningTask): Promise<void> {
    return new Promise<void>((resolve) => {
      if (task.settled) {
        resolve();
        return;
      }
      this.#settleWaiters.set(task.req.taskId, resolve);
    });
  }

  #finish(task: RunningTask, exitReason: string): void {
    if (task.settled) return;
    task.settled = true;
    task.state = exitReason === "completed" ? "settled" : "failed";
    this.#running.delete(task.req.taskId);
    if (task.child.task === task) {
      task.child.task = null;
      task.child.lastUsedAt = Date.now();
    }
    for (const [requestId, entry] of this.#uiOwner) {
      if (entry.child === task.child) this.#uiOwner.delete(requestId);
    }
    if (this.#focusedTaskId === task.req.taskId) this.#focusedTaskId = null;
    this.#emit(task, exitReason === "completed" ? Up.taskSettled : Up.taskFailed, {
      ...this.#taskPayload(task),
      exitReason,
    });
    this.#emitCapacity();
    this.#pump();
  }

  // ── 子进程管理 ──────────────────────────────────────────────

  async #ensureChild(workspace: string): Promise<Child> {
    const existing = this.#children.get(workspace);
    if (existing) return existing;

    if (this.#children.size >= this.#opts.maxLiveChildren) {
      await this.#evictOldestIdle();
    }

    const args: string[] = [];
    if (this.#opts.model) args.push("--model", this.#opts.model);
    if (this.#opts.sessionDir) args.push("--session-dir", this.#opts.sessionDir);
    if (this.#opts.approvalExtension) args.push("-e", this.#opts.approvalExtension);
    // 必须显式给出信任决定，否则 RPC 模式下会静默跳过项目级资源
    args.push(this.#opts.projectTrust === "approve" ? "--approve" : "--no-approve");

    const client = new PiClient({
      cwd: workspace,
      args,
      onStderr: (chunk) => this.#opts.log("pi stderr", { chunk: chunk.trim().slice(0, 200) }),
    });
    await client.start();

    const child: Child = {
      id: `c${++this.#childSeq}`,
      workspace,
      client,
      task: null,
      lastUsedAt: Date.now(),
    };
    this.#children.set(workspace, child);
    this.#wireChild(child);
    this.#opts.log("child 就绪", { childId: child.id, workspace, trust: this.#opts.projectTrust });
    return child;
  }

  /** 挂事件转发与审批转发。一个 child 同时只有一个 run，因此 taskId 唯一可判。 */
  #wireChild(child: Child): void {
    child.client.onRecord((rec) => {
      // 一个 child 只有一个 run，所以 agent_settled 必然属于当前 task
      if (rec.type === "agent_settled" && child.task && !child.task.settled) {
        const task = child.task;
        this.#finish(task, "completed");
        this.#settleWaiters.get(task.req.taskId)?.();
        this.#settleWaiters.delete(task.req.taskId);
      }
      this.#forwardPiEvent(child, rec);
    });
    child.client.onUiRequest((req) => this.#forwardUiRequest(child, req));
  }

  #forwardPiEvent(child: Child, rec: PiRecord): void {
    const task = child.task;
    if (!task) return;

    if (rec.type === "extension_error") {
      this.#opts.log("扩展错误", { error: String(rec.error), event: String(rec.event) });
    }

    // 跟踪最后一行输出，供未聚焦任务推摘要
    if (rec.type === "message_update") {
      const inner = rec.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        task.lastLine = (task.lastLine + inner.delta).slice(-400);
      }
    }

    const focused = this.#focusedTaskId === task.req.taskId;
    if (focused) {
      this.#up(
        envelope(Up.piEvent, {
          pairId: task.req.pairId,
          taskId: task.req.taskId,
          epoch: task.epoch,
          payload: rec,
        }),
      );
      return;
    }

    // 非聚焦：只按节流推摘要，避免多任务刷屏把带宽吃光
    const now = Date.now();
    if (now - task.lastSummaryAt >= SUMMARY_INTERVAL_MS) {
      task.lastSummaryAt = now;
      this.#up(
        envelope(Up.taskSummary, {
          pairId: task.req.pairId,
          taskId: task.req.taskId,
          epoch: task.epoch,
          payload: { summary: { lastLine: task.lastLine.replace(/\s+/g, " ").trim().slice(-160) } },
        }),
      );
    }
  }

  #forwardUiRequest(child: Child, req: UiRequest): void {
    const task = child.task;
    this.#uiOwner.set(req.id, { child, request: req });
    if (task) {
      task.state = "awaiting_approval";
      task.lastSummaryAt = 0;
    }
    this.#up(
      envelope(Up.uiRequest, {
        pairId: task?.req.pairId,
        taskId: task?.req.taskId,
        payload: {
          requestId: req.id,
          method: req.method,
          title: req.title,
          message: req.message,
          options: req.options,
          taskTitle: task ? basename(task.workspace) : undefined,
        },
      }),
    );
    if (task) {
      this.#emit(task, Up.taskAwaiting, { ...this.#taskPayload(task), summary: { pendingApproval: true } });
    }
  }

  async #switchWorkspace(child: Child, newCwd: string): Promise<PiClient> {
    if (!this.#workspaceAllowed(newCwd)) {
      throw new Error(`workspace ${newCwd} 不在白名单内`);
    }
    if (child.task) throw new Error("当前任务运行中，不能切换 workspace");

    this.#children.delete(child.workspace);
    await child.client.stop();
    const replacement = await this.#ensureChild(this.#resolveWorkspace(newCwd));
    return replacement.client;
  }

  async #evictOldestIdle(): Promise<void> {
    const idle = [...this.#children.values()]
      .filter((c) => c.task === null)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const victim = idle[0];
    if (!victim) return;
    this.#children.delete(victim.workspace);
    this.#opts.log("回收空闲 child", { childId: victim.id, workspace: victim.workspace });
    await victim.client.stop().catch(() => {});
  }

  async #recycleIdle(): Promise<void> {
    if (this.#children.size <= 1) return;
    const now = Date.now();
    for (const child of [...this.#children.values()]) {
      if (child.task !== null) continue;
      if (now - child.lastUsedAt < this.#opts.idleRecycleMs) continue;
      this.#children.delete(child.workspace);
      this.#opts.log("空闲回收", { childId: child.id, workspace: child.workspace });
      await child.client.stop().catch(() => {});
    }
    this.#emitCapacity();
  }

  // ── 工具 ────────────────────────────────────────────────────

  #anyChild(): Child | null {
    for (const child of this.#children.values()) return child;
    return null;
  }

  #workspaceAllowed(workspace: string): boolean {
    if (this.#opts.workspaces.length === 0) return false;
    const target = canonical(workspace);
    return this.#opts.workspaces.some((allowed) => {
      const base = canonical(allowed);
      return target === base || target.startsWith(base + "/");
    });
  }

  #resolveWorkspace(workspace: string): string {
    return canonical(workspace);
  }

  #taskPayload(task: RunningTask): Record<string, unknown> {
    return {
      taskId: task.req.taskId,
      workspace: task.workspace,
      isolation: task.req.isolation,
      childId: task.child.id,
      epoch: task.epoch,
      title: basename(task.workspace),
      startedAt: Date.now(),
    };
  }

  #emit(task: RunningTask, type: string, payload: Record<string, unknown>): void {
    this.#up(
      envelope(type, {
        pairId: task.req.pairId,
        taskId: task.req.taskId,
        epoch: task.epoch,
        payload,
      }),
    );
  }

  #up(env: Envelope): void {
    this.#opts.onUp(env);
  }

  #emitCapacity(): void {
    const cap = this.capacity();
    this.#up(envelope(Up.capacity, { payload: cap }));
  }
}

/**
 * 路径规范化。
 * macOS 上 /tmp 是 /private/tmp 的软链：不规范化会让同一目录被当成两个 workspace，
 * 会话目录、trust 查找、并发锁全部对不上。
 */
export function canonical(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (existsSync(trimmed)) {
    try {
      return realpathSync(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
