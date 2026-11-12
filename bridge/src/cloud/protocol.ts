/**
 * 云侧线格式。与 protocol/schema/envelope.json 保持一致。
 *
 * 铁律：可选字段一律省略而不是 `undefined` / `null`（JSON.stringify 会丢掉 undefined，
 * 所以我们只在有值时赋值）。
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

/** 帧类型：下行（云 → bridge） */
export const Down = {
  taskStart: "task.start",
  taskCancel: "task.cancel",
  taskInput: "task.input",
  taskFocus: "task.focus",
  controlExec: "control.exec",
  resume: "resume",
  uiResponse: "ui.response",
} as const;

/** 帧类型：上行（bridge → 云） */
export const Up = {
  hello: "bridge.hello",
  ping: "bridge.ping",
  capacity: "bridge.capacity",
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

export function nowMs(): number {
  return Date.now();
}

/** 构造信封；payload 为 undefined 时不写入字段。 */
export function envelope(type: string, fields: Partial<Envelope> = {}): Envelope {
  const env: Envelope = { v: PROTOCOL_VERSION, type, ts: nowMs() };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      (env as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return env;
}
