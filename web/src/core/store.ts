/**
 * 领域状态容器（纯 TS，零框架依赖）。
 *
 * 职责单一：把协议帧**归约**成可渲染的视图状态，并在节流窗口结束时产出一份
 * 不可变快照。它**不发请求、不建连接、不认识 DOM/框架**。
 *
 * 为什么单独一层（而不是直接在组件里 setState）：
 *   `text_delta` 每秒可能几十条。若每条都触发框架更新，手机会掉帧。
 *   这里把增量写入内部可变结构，最多 33ms 推送一次快照。
 */
import {
  Down,
  PairEvents,
  Up,
  type Capacity,
  type Envelope,
  type StreamHelloPayload,
  type UiRequestPayload,
} from "@wire";

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "settled"
  | "failed"
  | "cancelled"
  | string;

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; toolCallId: string; toolName: string; argsText: string; resultText?: string; isError?: boolean; durationMs?: number; done: boolean }
  | { kind: "user"; text: string }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "blobImage"; blobId: string; mimeType?: string; name?: string }
  | { kind: "file"; blobId: string; name: string; mimeType?: string; bytes?: number; note?: string };

export interface ApprovalRequest extends UiRequestPayload {
  taskId: string;
  receivedAt: number;
}

export interface TaskView {
  taskId: string;
  title: string;
  workspace: string;
  isolation: string;
  status: TaskStatus;
  cursor: number;
  startedAt?: number;
  settledAt?: number;
  exitReason?: string;
  lastLine: string;
  blocks: Block[];
  pendingApproval?: ApprovalRequest;
  /** 队列位次（queued 时） */
  queuePosition?: number;
  /** 是否已从磁盘拉取过完整历史 */
  historyLoaded?: boolean;
  /** 排队被挂起的原因（例如 terminal_busy：终端正在使用该目录） */
  holdReason?: string;
  /**
   * 待处理的插话（steer 队列）。
   *
   * 发送即乐观入队（用户立刻看到自己说了什么），随后 pi 的 queue_update
   * 事件用权威状态校准。pi 在当前回合结束时消费队列，queue_update 清空
   * → 队列项自动出队消失，无需额外动作。
   */
  pendingSteers: string[];
}

export interface AppView {
  tasks: TaskView[];
  byId: Record<string, TaskView>;
  approvals: ApprovalRequest[];
  capacity?: Capacity;
  bridgeOnline: boolean;
  lastSeq: number;
  updatedAt: number;
}

interface MutableTask extends TaskView {
  /** 已经从磁盘拉过完整历史 */
  historyLoaded?: boolean;
  /** 本段助手消息的起始块下标；message_end 时整段按权威内容重建 */
  segmentStart?: number;
}

const FLUSH_INTERVAL_MS = 33;

const EMPTY_VIEW: AppView = {
  tasks: [],
  byId: {},
  approvals: [],
  bridgeOnline: false,
  lastSeq: 0,
  updatedAt: 0,
};

export class TaskStore {
  #tasks = new Map<string, MutableTask>();
  #approvals = new Map<string, ApprovalRequest>();
  #capacity: Capacity | undefined;
  #bridgeOnline = false;
  #lastSeq = 0;

  #snapshot: AppView = EMPTY_VIEW;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #listeners = new Set<() => void>();

  // ── 订阅 ────────────────────────────────────────────────────

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): AppView {
    return this.#snapshot;
  }

  /** 每任务已收到的最新 seq，用于断线续传。 */
  cursors(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const task of this.#tasks.values()) {
      if (task.cursor > 0) out[task.taskId] = task.cursor;
    }
    return out;
  }

  reset(): void {
    this.#tasks.clear();
    this.#approvals.clear();
    this.#capacity = undefined;
    this.#bridgeOnline = false;
    this.#lastSeq = 0;
    this.#touch(true);
  }

  // ── 归约 ────────────────────────────────────────────────────

  ingestHello(payload: StreamHelloPayload): void {
    this.#bridgeOnline = payload.bridgeOn;
    if (payload.lastSeq > 0) this.#lastSeq = payload.lastSeq;
    this.#touch();
  }

  ingest(env: Envelope): void {
    if (typeof env.seq === "number" && env.seq > this.#lastSeq) this.#lastSeq = env.seq;

    switch (env.type) {
      case Up.piEvent:
        this.#applyPiEvent(env);
        break;
      case Up.taskEnqueued:
      case Up.taskStarted:
      case Up.taskSummary:
      case Up.taskAwaiting:
      case Up.taskSettled:
      case Up.taskFailed:
      case Up.taskCancelled:
      case Up.taskTitleUpdated:
        this.#applyTaskLifecycle(env);
        break;
      case Up.taskState: {
        const payload = (env.payload ?? {}) as { taskId?: string; status?: string; exitReason?: string };
        const taskId = payload.taskId ?? env.taskId;
        if (taskId && payload.status) {
          const task = this.#task(taskId);
          task.status = payload.status;
          if (payload.exitReason) task.exitReason = payload.exitReason;
          if (payload.status === "interrupted") task.settledAt = task.settledAt ?? env.ts;
        }
        break;
      }
      case Up.historyData:
        this.#applyHistory(env);
        break;
      case Up.uiRequest:
        this.#applyUiRequest(env);
        break;
      case Up.capacity:
        this.#capacity = env.payload as Capacity;
        break;
      case Up.online:
        this.#bridgeOnline = true;
        break;
      case Up.offline:
        this.#bridgeOnline = false;
        break;
      case PairEvents.revoked:
      case PairEvents.rejected:
        this.#bridgeOnline = false;
        break;
      default:
        return;
    }
    this.#touch();
  }

  /** 用 HTTP 拉到的任务摘要补齐 SSE 没见过的任务（冷启动场景）。 */
  mergeSummaries(summaries: Array<{ taskId: string; title: string; workspace: string; status: string; isolation: string; startedAt?: number; settledAt?: number; exitReason?: string }>): void {
    for (const s of summaries) {
      const existing = this.#tasks.get(s.taskId);
      if (existing) {
        existing.title = existing.title || s.title;
        existing.workspace = existing.workspace || s.workspace;
        if (!existing.startedAt) existing.startedAt = s.startedAt;
        if (!existing.settledAt) existing.settledAt = s.settledAt;
        if (!existing.exitReason) existing.exitReason = s.exitReason;
        // 不要用摘要覆盖实时状态（SSE 更新鲜）
        continue;
      }
      this.#tasks.set(s.taskId, {
        taskId: s.taskId,
        title: s.title,
        workspace: s.workspace,
        isolation: s.isolation,
        status: s.status,
        cursor: 0,
        startedAt: s.startedAt,
        settledAt: s.settledAt,
        exitReason: s.exitReason,
        lastLine: "",
        blocks: [],
        pendingSteers: [],
      });
    }
    this.#touch();
  }

  setBridgeOnline(online: boolean): void {
    this.#bridgeOnline = online;
    this.#touch();
  }

  setCapacity(capacity: Capacity | undefined): void {
    this.#capacity = capacity;
    this.#touch();
  }

  /**
   * 审批回答后本地立即清掉，避免用户重复点击（服务端仍是权威）。
   * 必须同时清任务上的 pendingApproval —— 详情页的弹层读的是它，
   * 只清 approvals 列表会导致「任务都结束了，弹窗还挂着」。
   */
  clearApproval(requestId: string): void {
    let changed = this.#approvals.delete(requestId);
    for (const task of this.#tasks.values()) {
      if (task.pendingApproval?.requestId === requestId) {
        task.pendingApproval = undefined;
        changed = true;
      }
    }
    if (changed) this.#touch();
  }

  // ── 内部：任务生命周期 ──────────────────────────────────────

  #task(taskId: string, patch: Partial<MutableTask> = {}): MutableTask {
    let task = this.#tasks.get(taskId);
    if (!task) {
      task = {
        taskId,
        title: patch.title ?? taskId.slice(0, 10),
        workspace: patch.workspace ?? "",
        isolation: patch.isolation ?? "shared",
        status: patch.status ?? "queued",
        cursor: 0,
        lastLine: "",
        blocks: [],
        pendingSteers: [],
      };
      this.#tasks.set(taskId, task);
    }
    Object.assign(task, patch);
    return task;
  }

  #applyTaskLifecycle(env: Envelope): void {
    const taskId = env.taskId ?? (env.payload as { taskId?: string } | undefined)?.taskId;
    if (!taskId) return;
    const payload = (env.payload ?? {}) as Record<string, unknown>;
    const task = this.#task(taskId);

    if (typeof payload.workspace === "string") task.workspace = payload.workspace;
    if (typeof payload.isolation === "string") task.isolation = payload.isolation;
    if (typeof payload.title === "string" && payload.title) task.title = payload.title;
    if (typeof payload.exitReason === "string") task.exitReason = payload.exitReason;
    if (typeof payload.queuePosition === "number") task.queuePosition = payload.queuePosition;
    if (typeof payload.holdReason === "string") task.holdReason = payload.holdReason;

    const statusByType: Record<string, TaskStatus> = {
      [Up.taskEnqueued]: "queued",
      [Up.taskStarted]: "running",
      [Up.taskAwaiting]: "awaiting_approval",
      [Up.taskSettled]: "settled",
      [Up.taskFailed]: "failed",
      [Up.taskCancelled]: "cancelled",
    };
    const nextStatus = statusByType[env.type];
    if (nextStatus) {
      task.status = nextStatus;
      // 任务真正开始/结束后，「终端占用」的挂起提示就不再成立
      if (nextStatus === "running" || nextStatus === "settled" || nextStatus === "failed") {
        task.holdReason = undefined;
      }
    }

    if (nextStatus === "running" && !task.startedAt) task.startedAt = env.ts;
    if ((nextStatus === "settled" || nextStatus === "failed" || nextStatus === "cancelled") && !task.settledAt) {
      task.settledAt = env.ts;
    }

    const summary = payload.summary as { lastLine?: string; pendingApproval?: boolean } | undefined;
    if (summary?.lastLine) task.lastLine = summary.lastLine;
    if (summary?.pendingApproval === false && task.pendingApproval) task.pendingApproval = undefined;

    // 终态任务不该再挂着审批弹层（pi 侧超时拒绝后可能不再发新事件）
    if (nextStatus === "settled" || nextStatus === "failed" || nextStatus === "cancelled") {
      if (task.pendingApproval) {
        this.#approvals.delete(task.pendingApproval.requestId);
        task.pendingApproval = undefined;
      }
    }

    this.#recordCursor(task, env);
  }

  // ── 内部：pi 事件 ───────────────────────────────────────────

  #applyPiEvent(env: Envelope): void {
    const taskId = env.taskId;
    if (!taskId) return;
    const rec = (env.payload ?? {}) as Record<string, unknown>;
    const task = this.#task(taskId);
    const type = String(rec.type ?? "");

    switch (type) {
      case "message_start": {
        const message = rec.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === "assistant") {
          task.segmentStart = task.blocks.length;
          task.status = "running";
        }
        break;
      }
      case "message_update": {
        const inner = rec.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (!inner?.delta) break;
        if (inner.type === "text_delta") {
          this.#appendText(task, "text", inner.delta);
          task.lastLine = (task.lastLine + inner.delta).slice(-200);
        } else if (inner.type === "thinking_delta") {
          this.#appendText(task, "thinking", inner.delta);
        }
        break;
      }
      case "message_end": {
        const message = rec.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === "assistant") {
          this.#rebuildSegment(task, message.content);
          task.segmentStart = undefined;
        } else if (message?.role === "user") {
          const text = contentToText(message.content);
          if (text) task.blocks.push({ kind: "user", text });
        }
        break;
      }
      case "pcp_artifact": {
        // agent 通过 pcp_send 把文件/截图发过来（blob 已上传，这里只有引用）
        const blobId = String(rec.blobId ?? "");
        if (blobId) {
          task.blocks.push({
            kind: rec.kind === "image" ? "blobImage" : "file",
            blobId,
            mimeType: typeof rec.mimeType === "string" ? rec.mimeType : undefined,
            name: typeof rec.name === "string" ? rec.name : "文件",
            bytes: typeof rec.bytes === "number" ? rec.bytes : undefined,
            note: typeof rec.note === "string" ? rec.note : undefined,
          });
          // blobImage 块需要 name，file 块需要 note/bytes：上面已按 kind 放好
          const last = task.blocks[task.blocks.length - 1];
          if (last && last.kind === "blobImage" && typeof rec.name === "string") last.name = rec.name;
        }
        break;
      }
      case "queue_update": {
        // pi 的权威插话队列：消费时 steering 变空 → 队列项自动出队
        const q = (rec as { steering?: unknown }).steering;
        const list = Array.isArray(q) ? q.filter((x): x is string => typeof x === "string") : [];
        if ((task.pendingSteers?.length ?? 0) !== list.length ||
            task.pendingSteers?.some((x, i) => x !== list[i])) {
          task.pendingSteers = list;
        }
        this.#touch();
        break;
      }
      case "tool_execution_start": {
        const toolCallId = String(rec.toolCallId ?? "");
        const toolName = String(rec.toolName ?? "tool");
        const args = rec.args as unknown;
        const existing = task.blocks.find((b) => b.kind === "tool" && b.toolCallId === toolCallId);
        if (existing && existing.kind === "tool") {
          existing.done = false;
        } else {
          task.blocks.push({
            kind: "tool",
            toolCallId,
            toolName,
            argsText: truncate(stringify(args), 240),
            done: false,
          });
        }
        break;
      }
      case "tool_execution_end": {
        const toolCallId = String(rec.toolCallId ?? "");
        let block = task.blocks.find((b) => b.kind === "tool" && b.toolCallId === toolCallId);
        if (!block) {
          block = {
            kind: "tool",
            toolCallId,
            toolName: String(rec.toolName ?? "tool"),
            argsText: "",
            done: false,
          };
          task.blocks.push(block);
        }
        if (block.kind === "tool") {
          block.done = true;
          block.isError = Boolean(rec.isError);
          block.resultText = truncate(stringify(rec.result), 400);
          if (typeof rec.durationMs === "number") block.durationMs = rec.durationMs;
        }
        break;
      }
      case "agent_settled": {
        task.status = rec.aborted ? "cancelled" : "settled";
        if (!task.settledAt) task.settledAt = env.ts;
        if (task.pendingSteers?.length) {
          task.pendingSteers = [];
          this.#touch();
        }
        // 同一处再兜一次：pi 已 settle，任何残留审批都失效了
        if (task.pendingApproval) {
          this.#approvals.delete(task.pendingApproval.requestId);
          task.pendingApproval = undefined;
        }
        break;
      }
      default:
        break;
    }

    this.#recordCursor(task, env);
  }

  #appendText(task: MutableTask, kind: "text" | "thinking", delta: string): void {
    const last = task.blocks[task.blocks.length - 1];
    if (last && last.kind === kind) {
      last.text += delta;
      return;
    }
    task.blocks.push(kind === "text" ? { kind: "text", text: delta } : { kind: "thinking", text: delta });
  }

  /** message_end 是权威终态：用它的 content 重建本段，消掉流式拼接误差。 */
  #rebuildSegment(task: MutableTask, content: unknown): void {
    if (task.segmentStart === undefined) return;
    const rebuilt = blocksFromContent(content);
    if (rebuilt.length === 0) {
      task.segmentStart = undefined;
      return;
    }
    task.blocks.splice(task.segmentStart, task.blocks.length - task.segmentStart, ...rebuilt);
  }

  // ── 内部：历史回放 ──────────────────────────────────────────

  /**
   * 历史是权威数据（来自磁盘会话文件），直接替换 blocks。
   * 与实时流拼接的内容相比，它更完整、顺序更正确。
   */
  #applyHistory(env: Envelope): void {
    const payload = (env.payload ?? {}) as {
      taskId?: string;
      blocks?: Block[];
      missing?: boolean;
      truncated?: boolean;
    };
    const taskId = payload.taskId ?? env.taskId;
    if (!taskId) return;
    const task = this.#task(taskId);

    if (payload.missing) {
      task.lastLine = task.lastLine || "（历史会话文件已不存在）";
      return;
    }
    if (!Array.isArray(payload.blocks) || payload.blocks.length === 0) return;

    task.blocks = payload.blocks.map((block) => ({ ...block }));
    task.historyLoaded = true;
  }

  // ── 内部：审批 ──────────────────────────────────────────────

  #applyUiRequest(env: Envelope): void {
    const payload = (env.payload ?? {}) as UiRequestPayload;
    if (!payload.requestId) return;
    const taskId = env.taskId ?? "";
    const approval: ApprovalRequest = {
      ...payload,
      taskId,
      receivedAt: env.ts,
    };
    this.#approvals.set(payload.requestId, approval);
    if (taskId) {
      const task = this.#task(taskId);
      task.pendingApproval = approval;
      task.status = "awaiting_approval";
      this.#recordCursor(task, env);
    }
  }

  #recordCursor(task: MutableTask, env: Envelope): void {
    if (typeof env.seq === "number" && env.seq > task.cursor) task.cursor = env.seq;
  }

  /**
   * 插话乐观入队：发送成功立即上屏，不等 pi 的 queue_update（虽然它通常
   * 立刻就到）。queue_update 到达时以权威列表整体替换，不会产生重复。
   */
  optimisticSteer(taskId: string, text: string): void {
    if (!text) return;
    const task = this.#task(taskId);
    task.pendingSteers = [...(task.pendingSteers ?? []), text];
    this.#touch(true);
  }

  // ── 内部：快照 ──────────────────────────────────────────────

  #touch(immediate = false): void {
    if (immediate) {
      this.#rebuild();
      return;
    }
    if (this.#dirty) return;
    this.#dirty = true;
    this.#timer = setTimeout(() => {
      this.#dirty = false;
      this.#timer = null;
      this.#rebuild();
    }, FLUSH_INTERVAL_MS);
  }

  #rebuild(): void {
    // 深拷贝到不可变快照：Vue 用 shallowRef 只换引用，不追踪内部变化
    const tasks: TaskView[] = [];
    const byId: Record<string, TaskView> = {};
    for (const task of this.#tasks.values()) {
      const copy: TaskView = {
        taskId: task.taskId,
        title: task.title,
        workspace: task.workspace,
        isolation: task.isolation,
        status: task.status,
        cursor: task.cursor,
        lastLine: task.lastLine,
        blocks: task.blocks.map((block) => ({ ...block })),
        pendingSteers: [...(task.pendingSteers ?? [])],
      };
      if (task.startedAt !== undefined) copy.startedAt = task.startedAt;
      if (task.settledAt !== undefined) copy.settledAt = task.settledAt;
      if (task.exitReason !== undefined) copy.exitReason = task.exitReason;
      if (task.pendingApproval !== undefined) copy.pendingApproval = task.pendingApproval;
      if (task.queuePosition !== undefined) copy.queuePosition = task.queuePosition;
      if (task.historyLoaded !== undefined) copy.historyLoaded = task.historyLoaded;
      if (task.holdReason !== undefined) copy.holdReason = task.holdReason;
      tasks.push(copy);
      byId[copy.taskId] = copy;
    }

    // 活跃优先，其次按开始时间倒序
    const weight = (status: TaskStatus): number =>
      status === "awaiting_approval" ? 0 : status === "running" ? 1 : status === "queued" ? 2 : 3;
    tasks.sort((a, b) => {
      const delta = weight(a.status) - weight(b.status);
      if (delta !== 0) return delta;
      return (b.startedAt ?? 0) - (a.startedAt ?? 0);
    });

    const view: AppView = {
      tasks,
      byId,
      approvals: [...this.#approvals.values()].sort((a, b) => a.receivedAt - b.receivedAt),
      bridgeOnline: this.#bridgeOnline,
      lastSeq: this.#lastSeq,
      updatedAt: Date.now(),
    };
    if (this.#capacity) view.capacity = this.#capacity;

    this.#snapshot = view;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }
}

// ── 纯函数助手 ────────────────────────────────────────────────

/** 统一取工具调用参数：兼容 arguments(JSON 字符串) / input / args 三种写法。 */
export function toolArgs(block: unknown): unknown {
  if (typeof block !== "object" || block === null) return undefined;
  const b = block as { arguments?: unknown; input?: unknown; args?: unknown };
  const raw = b.arguments ?? b.input ?? b.args;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

function blocksFromContent(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ kind: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.text === "string") {
      out.push({ kind: "thinking", text: block.text });
    } else if (
      block.type === "image" &&
      typeof (block as { data?: unknown }).data === "string"
    ) {
      const img = block as { data: string; mimeType?: string };
      out.push({ kind: "image", data: img.data, mimeType: img.mimeType ?? "image/png" });
    } else if (
      block.type === "blobImage" &&
      typeof (block as { blobId?: unknown }).blobId === "string"
    ) {
      const ref = block as { blobId: string; mimeType?: string; name?: string };
      out.push({ kind: "blobImage", blobId: ref.blobId, mimeType: ref.mimeType, name: ref.name });
    } else if ((block.type === "toolCall" || block.type === "tool_call") && block.id) {
      out.push({
        kind: "tool",
        toolCallId: block.id,
        toolName: block.name ?? "tool",
        // pi 的 toolCall 块字段是 arguments（JSON 字符串），不是 input；
        // 只读 input 会得到 undefined（实测）
        argsText: truncate(stringify(toolArgs(block)), 240),
        done: false,
      });
    }
  }
  return out;
}

/** 供 UI 判断：这个任务是否已经不会再自动继续。 */
export function isTerminal(status: TaskStatus): boolean {
  return status === "settled" || status === "failed" || status === "cancelled" || status === "interrupted";
}

export { Down };
