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
import { basename, extname } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { PiClient, isUiRequest, type PiRecord, type UiRequest } from "../pi/client.ts";
import { execControl, type ControlResult } from "../control/index.ts";
import { isWorkspaceBusyByTerminal } from "./busy.ts";
import { envelope, Up, type Envelope } from "./protocol.ts";
import { INLINE_IMAGE_B64_LIMIT, type BlobUploader } from "./blobupload.ts";
import { rewriteLargeImages } from "./image-transform.ts";

export interface RunnerOptions {
  workspaces: string[];
  maxRunning: number;
  maxLiveChildren: number;
  idleRecycleMs: number;
  model?: string;
  sessionDir?: string;
  /** 审批扩展路径；为空表示不加载（危险，仅调试） */
  approvalExtension?: string;
  /** pcp_send 扩展路径（agent 主动把文件发给手机） */
  pcpSendExtension?: string;
  /** sidecar 记录目录（~/.pi/bridge），pcp_send 的发送历史落这里 */
  bridgeBaseDir?: string;
  /** 审批策略，透传给 pi 子进程里的审批扩展 */
  approvalPolicy: "balanced" | "strict";
  /** deny = 不加载项目级资源（默认、安全）；approve = 加载 */
  projectTrust: "approve" | "deny";
  /**
   * 终端避让窗口（毫秒）：该 workspace 的会话文件在窗口内被**非 bridge** 进程
   * 写过，就视为"人在终端里用"，任务排队等待。0 = 关闭避让。
   */
  terminalBusyWindowMs: number;
  onUp: (env: Envelope) => void;
  log: (msg: string, data?: Record<string, unknown>) => void;
  /**
   * 图片转存上传器。agent 产出的内联 base64 大图（超过 INLINE_IMAGE_B64_LIMIT）
   * 转发前传成 blob，事件里换成引用。未提供时大图降级为占位（见 #forwardPiEvent）。
   */
  uploader?: BlobUploader;
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

interface HeldTask {
  taskId: string;
  workspace: string;
  since: number;
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
  /** 最近一次拿到的 sessionId，用于把"自己写的会话"从忙碌判定里排除 */
  sessionId?: string;
}

const SUMMARY_INTERVAL_MS = 1_000;

export class Runner {
  #opts: RunnerOptions;
  #queue: TaskRequest[] = [];
  #running = new Map<string, RunningTask>();
  #children = new Map<string, Child>();
  #childSeq = 0;
  /** 已结束任务的会话上下文：follow_up 重建子进程时要靠 workspace + sessionId */
  #finishedTasks = new Map<string, { sessionId: string; workspace: string; pairId: string }>();
  #focusedTaskId: string | null = null;
  /** requestId → 发起它的 child 与**请求详情**（对账时要重发给手机） */
  #uiOwner = new Map<string, { child: Child; request: UiRequest }>();
  /** 最近一次见到的 pairId，用于给已结束任务补上行帧的归属 */
  #lastPairId: string | undefined;
  #settleWaiters = new Map<string, () => void>();
  /** workspace → 因"终端正在使用"被挂起的时间，用于只提示一次 */
  #heldByTerminal = new Map<string, number>();
  #pumpTimer: ReturnType<typeof setTimeout> | null = null;
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

  /**
   * 任务结束后继续对话（follow_up）。
   *
   * 任务 settle 时从 #running 摘除，但 pi 子进程通常还活着（空闲保留窗口内），
   * 直接复用；已被回收就按 workspace + --session-id 重建 —— 上下文在磁盘
   * session 文件里，重建的进程能完整续上（实测 messageCount 与历史一致）。
   *
   * 两条路径都必须建立 RunningTask 并挂到 child.task 上：事件转发
   * （#forwardPiEvent）依赖它把 pi 事件归因到这个 taskId，否则手机收不到。
   */
  async followUp(taskId: string, text: string): Promise<void> {
    const ctx = this.#finishedTasks.get(taskId);
    if (!ctx) throw new Error("unknown_task");

    let child = this.#children.get(ctx.workspace);
    if (child) {
      if (child.task) {
        // 同 workspace 还有别的任务在跑：排队而不是抢
        throw new Error("workspace_busy");
      }
      if (child.sessionId !== ctx.sessionId) {
        // 该 workspace 的子进程已续到别的会话（比如它之后跑了新任务开了新 session）：
        // 不能直接往它身上发。停掉它，按 sessionId 重建。
        this.#children.delete(ctx.workspace);
        await child.client.stop().catch(() => {});
        child = undefined;
      }
    }
    if (!child) {
      child = await this.#ensureChild(ctx.workspace, ctx.sessionId);
    }

    const task: RunningTask = {
      req: { taskId, pairId: ctx.pairId, workspace: ctx.workspace, prompt: text, isolation: "shared" },
      workspace: ctx.workspace,
      child,
      epoch: 1,
      state: "running",
      lastLine: "",
      lastSummaryAt: 0,
      settled: false,
    };
    child.task = task;
    child.lastUsedAt = Date.now();
    this.#running.set(taskId, task);
    this.#lastPairId = ctx.pairId;
    if (!this.#focusedTaskId) this.#focusedTaskId = taskId;
    this.#emit(task, Up.taskStarted, { ...this.#taskPayload(task), sessionId: ctx.sessionId });
    this.#emitCapacity();
    this.#opts.log("follow_up", { taskId, sessionId: ctx.sessionId.slice(0, 8), reused: Boolean(this.#finishedTasks.get(taskId)?.workspace === ctx.workspace) });

    void (async () => {
      try {
        // 用 prompt 而不是 follow_up RPC：恢复/复用来的子进程处于空闲，
        // follow_up RPC 只会把消息排队（disposition:queued）不触发 turn，
        // prompt 才能开新 run（实测事件流完整、agent_settled 正常发）。
        await child.client.prompt(text);
      } catch (error) {
        this.#opts.log("follow_up 投递失败", { taskId, error: String(error) });
      }
      await this.#waitSettled(task).catch(() => {});
    })();
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
    // 历史块里的内联大图 → blob 引用，避免 historyData 帧被撑大
    const blocks = await this.#blobsifyHistoryImages(result.blocks, req.pairId || this.#pairIdFor(req.taskId));
    // 合并 pcp_send 的发送记录：pi 的 JSONL 不存自定义工具的 details，
    // 历史里「agent 发过什么文件」只能靠 sidecar 回放（刷新/重连后不能丢）
    if (this.#opts.bridgeBaseDir) {
      const { loadArtifacts, artifactsToBlocks } = await import("./artifacts.ts");
      const artifacts = artifactsToBlocks(loadArtifacts(this.#opts.bridgeBaseDir, req.taskId));
      if (artifacts.length > 0) blocks.push(...artifacts);
    }
    this.#opts.log("历史读取", {
      taskId: req.taskId,
      blocks: blocks.length,
      missing: Boolean(result.missing),
    });
    this.#opts.onUp(
      envelope(Up.historyData, {
        pairId: req.pairId || this.#pairIdFor(req.taskId),
        taskId: req.taskId,
        payload: {
          taskId: req.taskId,
          blocks,
          ...(result.missing ? { missing: true } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        },
      }),
    );
  }

  /** 把历史里的内联大图换成 blobImage 引用；小图与无上传器时原样保留。 */
  async #blobsifyHistoryImages(blocks: unknown[], pairId: string | undefined): Promise<unknown[]> {
    const uploader = this.#opts.uploader;
    if (!uploader || !pairId) return blocks;
    const out: unknown[] = [];
    for (const raw of blocks) {
      const block = raw as {
        kind?: string;
        data?: string;
        mimeType?: string;
        blobId?: string;
      };
      if (block.kind === "image" && typeof block.data === "string" && block.data.length > INLINE_IMAGE_B64_LIMIT) {
        const mimeType = block.mimeType ?? "image/png";
        const name = this.#nameForMime(mimeType);
        const result = await uploader.uploadImage(block.data, mimeType, pairId, name);
        if (result) {
          out.push({ kind: "blobImage", blobId: result.blobId, mimeType: result.mimeType ?? mimeType, name: result.name ?? name });
          continue;
        }
        // 转存失败：历史里的图丢了就丢了，用占位替代，不阻塞其它块
        this.#opts.log("历史图片转存失败，已降级", { mimeType, bytes: block.data.length });
        out.push({ kind: "text", text: "（历史图片过大，未能转存）" });
        continue;
      }
      out.push(block);
    }
    return out;
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
    if (this.#pumpTimer) {
      clearTimeout(this.#pumpTimer);
      this.#pumpTimer = null;
    }
    const children = [...this.#children.values()];
    this.#children.clear();
    await Promise.allSettled(children.map((c) => c.client.stop()));
  }

  // ── 调度 ────────────────────────────────────────────────────

  #pump(): void {
    if (this.#closed) return;
    void this.#pumpAsync();
  }

  async #pumpAsync(): Promise<void> {
    if (this.#closed) return;
    while (this.#running.size < this.#opts.maxRunning && this.#queue.length > 0) {
      // 同一 workspace 内串行：跳过正在被占用的 workspace
      const busy = new Set([...this.#running.values()].map((t) => t.workspace));

      let picked = -1;
      let heldAny = false;
      for (let i = 0; i < this.#queue.length; i += 1) {
        const candidate = this.#queue[i];
        if (!candidate) continue;
        const workspace = this.#resolveWorkspace(candidate.workspace);
        if (busy.has(workspace)) continue;

        // 终端避让：人在这个目录里用 pi，就先不动它
        const verdict = await this.#terminalBusy(workspace, candidate.workspace);
        if (verdict.busy) {
          heldAny = true;
          this.#holdForTerminal(candidate, workspace, verdict.ageMs ?? 0);
          continue;
        }
        this.#heldByTerminal.delete(workspace);
        picked = i;
        break;
      }

      if (picked < 0) {
        if (heldAny) this.#schedulePump(10_000);
        return;
      }
      const [req] = this.#queue.splice(picked, 1);
      if (!req) return;
      void this.#run(req);
    }
  }

  /**
   * 终端占用检查。
   *  - 排除自己子进程的 sessionId（否则自己的写入会被当成"人在用"）
   *  - 同时查归一化前后的路径（软链会让会话目录名不一致）
   */
  async #terminalBusy(workspace: string, rawWorkspace?: string): Promise<{ busy: boolean; ageMs?: number }> {
    if (this.#opts.terminalBusyWindowMs <= 0) return { busy: false };
    const own = new Set<string>();
    for (const child of this.#children.values()) {
      if (child.sessionId) own.add(child.sessionId);
    }
    const extra = rawWorkspace && rawWorkspace !== workspace ? [rawWorkspace] : [];
    return isWorkspaceBusyByTerminal(workspace, {
      windowMs: this.#opts.terminalBusyWindowMs,
      ownSessionIds: own,
      sessionDir: this.#opts.sessionDir,
      extraWorkspaces: extra,
    });
  }

  /** 同一次挂起只通知一次，避免每 10 秒刷一条。 */
  #holdForTerminal(req: TaskRequest, workspace: string, ageMs: number): void {
    if (this.#heldByTerminal.has(workspace)) return;
    this.#heldByTerminal.set(workspace, Date.now());
    this.#opts.log("终端正在使用该目录，任务排队", {
      taskId: req.taskId,
      workspace,
      lastWriteAgoMs: ageMs,
    });
    this.#up(
      envelope(Up.taskEnqueued, {
        pairId: req.pairId,
        taskId: req.taskId,
        payload: {
          taskId: req.taskId,
          workspace,
          holdReason: "terminal_busy",
          status: "queued",
        },
      }),
    );
  }

  #schedulePump(delayMs: number): void {
    if (this.#pumpTimer) return;
    this.#pumpTimer = setTimeout(() => {
      this.#pumpTimer = null;
      this.#pump();
    }, delayMs);
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
        child.sessionId = sessionId;
        this.#finishedTasks.set(task.req.taskId, {
          sessionId,
          workspace: task.workspace,
          pairId: task.req.pairId,
        });
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

  async #ensureChild(workspace: string, sessionId?: string): Promise<Child> {
    const existing = this.#children.get(workspace);
    if (existing) return existing;

    if (this.#children.size >= this.#opts.maxLiveChildren) {
      await this.#evictOldestIdle();
    }

    const args: string[] = [];
    if (this.#opts.model) args.push("--model", this.#opts.model);
    // 恢复旧会话（follow_up 重建子进程时）：--session-id 让 pi 从磁盘 session 文件
    // 完整加载上下文（实测 messageCount 与历史一致）
    if (sessionId) args.push("--session-id", sessionId);
    if (this.#opts.sessionDir) args.push("--session-dir", this.#opts.sessionDir);
    if (this.#opts.approvalExtension) args.push("-e", this.#opts.approvalExtension);
    if (this.#opts.pcpSendExtension) args.push("-e", this.#opts.pcpSendExtension);
    // 必须显式给出信任决定，否则 RPC 模式下会静默跳过项目级资源
    args.push(this.#opts.projectTrust === "approve" ? "--approve" : "--no-approve");

    const client = new PiClient({
      cwd: workspace,
      args,
      // 审批扩展在 pi 进程里读这个环境变量
      env: { PCP_APPROVAL_POLICY: this.#opts.approvalPolicy },
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
      void this.#forwardPiEvent(child, rec);
    });
    child.client.onUiRequest((req) => this.#forwardUiRequest(child, req));
  }

  /**
   * 转发前把超大的内联图片换成 blob 引用。
   *
   * 只有 assistant_message（权威终态）里的内联图片可能超大；message_update 只带
   * text/thinking delta，不会带 base64 图片。改写是异步的：命中大图时先不转发，
   * 上传完成后再把**改写后的**事件发出去。上传失败则降级为占位文本，避免把
   * 超大 base64 硬塞进 wss 帧（会撞 4MB 读限）。
   */
  async #forwardPiEvent(child: Child, rec: PiRecord): Promise<void> {
    const task = child.task;
    if (!task) return;

    if (rec.type === "extension_error") {
      this.#opts.log("扩展错误", { error: String(rec.error), event: String(rec.event) });
    }

    // agent 通过 pcp_send 主动发文件：上传成 blob，推给手机，记 sidecar
    if (rec.type === "tool_execution_end" && rec.toolName === "pcp_send") {
      void this.#handlePcpSend(child, rec as PiRecord & { result?: { details?: { pcpSend?: { path: string; size: number; note?: string } } } });
    }

    // 跟踪最后一行输出，供未聚焦任务推摘要
    if (rec.type === "message_update") {
      const inner = rec.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        task.lastLine = (task.lastLine + inner.delta).slice(-400);
      }
    }

    // 命中需要改写的事件：把大图片换 blob。返回改写后的记录（可能相同）。
    const outgoing = await this.#materializeInlineImages(child, rec);

    const focused = this.#focusedTaskId === task.req.taskId;
    if (focused) {
      this.#up(
        envelope(Up.piEvent, {
          pairId: task.req.pairId,
          taskId: task.req.taskId,
          epoch: task.epoch,
          payload: outgoing,
        }),
      );
      return;
    }

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

  /**
   * agent 调用 pcp_send 把文件发给手机。
   * 扩展只做了校验与返回 details.pcpSend；真正的读取、上传、推送在这里。
   */
  async #handlePcpSend(child: Child, rec: PiRecord & { result?: { details?: { pcpSend?: { path: string; size: number; note?: string } } } }): Promise<void> {
    const task = child.task;
    const details = rec.result?.details?.pcpSend;
    if (!task || !details?.path) return;
    const pairId = task.req.pairId;
    const uploader = this.#opts.uploader;
    if (!uploader) {
      this.#opts.log("pcp_send 无上传器，忽略", { taskId: task.req.taskId });
      return;
    }
    const name = basename(details.path);
    const mimeType = guessMime(details.path);
    const kind = mimeType.startsWith("image/") ? "image" : "file";
    const result = await uploader.uploadLocalFile(details.path, mimeType, pairId, name);
    if (!result) {
      this.#opts.log("pcp_send 上传失败", { taskId: task.req.taskId, path: details.path });
      return;
    }
    // 推给手机：复用 piEvent 透传，负载是一个合成的 pcp_artifact 记录
    this.#up(
      envelope(Up.piEvent, {
        pairId,
        taskId: task.req.taskId,
        epoch: task.epoch,
        payload: {
          type: "pcp_artifact",
          blobId: result.blobId,
          kind,
          name: name,
          mimeType: result.mimeType ?? mimeType,
          bytes: details.size,
          note: details.note,
        },
      }),
    );
    // 记 sidecar：pi 的 JSONL 不存 details，历史回放靠它
    if (this.#opts.bridgeBaseDir) {
      const { recordArtifact } = await import("./artifacts.ts");
      recordArtifact(this.#opts.bridgeBaseDir, {
        taskId: task.req.taskId,
        blobId: result.blobId,
        kind,
        name,
        mimeType: result.mimeType ?? mimeType,
        bytes: details.size,
        note: details.note,
        at: Date.now(),
      });
    }
    this.#opts.log("pcp_send 已发送", { taskId: task.req.taskId, name, kind, bytes: details.size });
  }

  /**
   * 扫描事件里的内联 base64 图片，把超阈值的转成 blob 引用。
   *
   * 结构：pi 的 assistant_message 事件形如
   *   { type, message: { role:"assistant", content: [ {type:"text",...}, {type:"image",data,mimeType}, ... ] } }
   * 我们递归找所有 { type:"image", data, mimeType } 块，逐个判断是否需要转存。
   * 小图直接内联（省一次往返）；大图上传成 blob，事件里换成
   *   { type:"blobImage", blobId, mimeType, name }
   * 手机 store 据此用签名 URL 渲染。
   */
  async #materializeInlineImages(child: Child, rec: PiRecord): Promise<PiRecord> {
    const content = this.#extractImageContent(rec);
    if (!content) return rec;
    const pairId = child.task?.req.pairId ?? this.#lastPairId;
    const uploader = this.#opts.uploader;
    const { content: out, changed } = await rewriteLargeImages(content, {
      limit: INLINE_IMAGE_B64_LIMIT,
      // 无上传器或无 pair 归属时 process 返回 null → 占位降级（避免撞帧上限）
      process: async (block) => {
        if (!uploader || !pairId) return null;
        const mimeType = block.mimeType ?? "image/png";
        const result = await uploader.uploadImage(block.data, mimeType, pairId, this.#nameForMime(mimeType));
        if (!result) return null;
        return {
          type: "blobImage",
          blobId: result.blobId,
          mimeType: result.mimeType ?? mimeType,
          name: result.name,
        };
      },
      fallback: () => ({ type: "text", text: "（图片过大且未能转存，无法显示）" }),
    });
    if (!changed) return rec;
    return { ...rec, message: { ...((rec as any).message ?? {}), content: out } };
  }

  /** 从事件里取出可能是图片数组的 content；没有就返回 null。 */
  #extractImageContent(rec: PiRecord): unknown[] | null {
    const msg = (rec as { message?: { role?: string; content?: unknown } }).message;
    if (msg && Array.isArray(msg.content)) return msg.content as unknown[];
    return null;
  }

  #isImageBlock(block: unknown): block is { type: string; data: string; mimeType?: string } {
    if (typeof block !== "object" || block === null) return false;
    const b = block as { type?: unknown; data?: unknown };
    return b.type === "image" && typeof b.data === "string";
  }

  #nameForMime(mime: string): string {
    const base = mime.includes("/") ? mime.split("/")[1] : mime;
    const ext = base?.split("+")[0] || "png";
    return `agent-${Date.now()}.${ext}`;
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


// ── 工具函数 ─────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain",
  ".log": "text/plain", ".csv": "text/csv", ".zip": "application/zip",
  ".html": "text/html", ".js": "text/javascript", ".ts": "text/typescript",
};
function guessMime(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}
