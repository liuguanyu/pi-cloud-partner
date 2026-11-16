/**
 * 线格式唯一真相源（TS 侧）。
 *
 * bridge 与 web 都从这里引用，**不要各自复制一份** —— 复制必然漂移。
 * 与 protocol/schema/*.json 保持一致；Go 侧由 internal/protocol 对应实现。
 *
 * 本文件只放「类型与常量」，不放任何运行时逻辑或副作用，
 * 这样它可以被浏览器包、Node 进程、测试同时引用。
 */

export const PROTOCOL_VERSION = 1;

export interface Envelope {
  v: number;
  type: string;
  ts: number;
  pairId?: string;
  taskId?: string;
  runId?: string;
  epoch?: number;
  seq?: number;
  cmdId?: string;
  payload?: unknown;
}

/** 下行（云 → bridge） */
export const Down = {
  taskStart: "task.start",
  taskCancel: "task.cancel",
  taskInput: "task.input",
  taskFocus: "task.focus",
  controlExec: "control.exec",
  resume: "resume",
  uiResponse: "ui.response",
  /** 请求某任务的历史（正文在 bridge 磁盘，云端不存） */
  historyGet: "history.get",
} as const;

/** 上行（bridge → 云） */
export const Up = {
  hello: "bridge.hello",
  welcome: "bridge.welcome",
  ping: "bridge.ping",
  capacity: "bridge.capacity",
  online: "bridge.online",
  offline: "bridge.offline",
  piEvent: "pi.event",
  uiRequest: "ui.request",
  controlResult: "control.result",
  controlQueued: "control.queued",
  taskEnqueued: "task.enqueued",
  taskStarted: "task.started",
  taskSummary: "task.summary",
  taskAwaiting: "task.awaiting_approval",
  taskSettled: "task.settled",
  taskFailed: "task.failed",
  taskCancelled: "task.cancelled",
  taskTitleUpdated: "task.title_updated",
  /** history.get 的应答 */
  historyData: "history.data",
  /**
   * bridge 重连后主动上报自己当前真实持有的任务状态。
   * 云端 tasks 表只是缓存，事件断流就会停在旧值，靠这一帧回源校正。
   */
  stateSnapshot: "state.snapshot",
  /** 云端把校正结果推给手机（也用于把「断连期间结束」的任务标成 interrupted） */
  taskState: "task.state",
} as const;

/** 配对相关（云端向手机 SSE 推送） */
export const PairEvents = {
  approved: "pair.approved",
  rejected: "pair.rejected",
  revoked: "pair.revoked",
  contested: "pair.contested",
} as const;

/** SSE 握手帧（云端在流开始时发，不属于 schema 的 Envelope） */
export const StreamHello = "stream.hello";

/** 白名单下的候选目录，供手机端做选择器 */
export interface DirEntry {
  path: string;
  name: string;
  /** 0 = 白名单根，1 = 一级，2 = 二级 */
  depth: number;
  isGit: boolean;
}

export interface BridgeHello {
  deviceId: string;
  version: number;
  workspaces: string[];
  /** 扫出来的候选目录（含 git 标记），让手机端能直接选而不是手打路径 */
  dirs?: DirEntry[];
  name: string;
  maxRunning: number;
  liveChildren: number;
}

export interface BridgeWelcome {
  version: number;
  pairIds: string[];
  serverTime: number;
}

export interface Capacity {
  running: number;
  maxRunning: number;
  liveChildren: number;
  maxLiveChildren: number;
  queued?: number;
  memMB?: number;
  memLimitMB?: number;
}

export interface StreamHelloPayload {
  pairId: string;
  lastSeq: number;
  bridgeOn: boolean;
  serverTS: number;
  /** 云端进程标识：变了说明 seq 已归零，本地游标必须丢弃 */
  bootId?: string;
}

/** 审批请求载荷（云 → 手机），由 bridge 的 extension_ui_request 映射而来 */
export interface UiRequestPayload {
  requestId: string;
  method: "confirm" | "select" | "input" | "editor" | string;
  title?: string;
  message?: string;
  options?: string[];
  taskTitle?: string;
}

/** 任务摘要（云端 tasks 表） */
export interface TaskSummary {
  taskId: string;
  status: string;
  title: string;
  workspace: string;
  isolation: string;
  startedAt?: number;
  settledAt?: number;
  exitReason?: string;
}

/** history.get 载荷：云端从 tasks 表里取出 sessionId 一并下发 */
export interface HistoryGetPayload {
  taskId: string;
  sessionId: string;
  /** 任务开始时间（unix ms）。bridge 据此裁剪，避免返回整个会话 */
  sinceMs?: number;
}

/** history.data 载荷：扁平 block 列表，与 web 的 TaskView.blocks 同构 */
export interface HistoryDataPayload {
  taskId: string;
  blocks: Array<{
    kind: "text" | "thinking" | "user" | "tool";
    text?: string;
    toolCallId?: string;
    toolName?: string;
    argsText?: string;
    resultText?: string;
    isError?: boolean;
  }>;
  missing?: boolean;
  truncated?: boolean;
}

/** 待审批请求的完整信息，重连后云端用它把弹层重新推给手机 */
export interface PendingApproval {
  requestId: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  taskId: string;
}

/** state.snapshot 载荷：bridge 视角的真相 */
export interface StateSnapshotPayload {
  tasks: Array<{
    taskId: string;
    status: "running" | "queued" | "awaiting_approval";
    /** awaiting_approval 时带上，云端据此重发 ui.request */
    approval?: PendingApproval;
  }>;
}

/** task.state 载荷：云端校正后的状态 */
export interface TaskStatePayload {
  taskId: string;
  status: string;
  exitReason?: string;
}

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Envelope;
  return typeof candidate.type === "string" && typeof candidate.ts === "number";
}
