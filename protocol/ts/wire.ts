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

export interface BridgeHello {
  deviceId: string;
  version: number;
  workspaces: string[];
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

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Envelope;
  return typeof candidate.type === "string" && typeof candidate.ts === "number";
}
