/**
 * 协议层（bridge 侧）。
 *
 * 类型与帧名常量从 `protocol/ts/wire.ts` 复用 —— 单一真相源，不复制。
 * 本文件只保留 bridge 需要的运行时辅助（构造信封、取时间）。
 */

export {
  PROTOCOL_VERSION,
  Down,
  Up,
  PairEvents,
  StreamHello,
  isEnvelope,
  type Envelope,
  type BridgeHello,
  type BridgeWelcome,
  type Capacity,
  type UiRequestPayload,
  type StreamHelloPayload,
  type TaskSummary,
} from "../../../protocol/ts/wire.ts";

import { PROTOCOL_VERSION, type Envelope } from "../../../protocol/ts/wire.ts";

export function nowMs(): number {
  return Date.now();
}

/** 构造信封；值为 undefined 的字段不写入（禁止 null）。 */
export function envelope(type: string, fields: Partial<Envelope> = {}): Envelope {
  const env: Envelope = { v: PROTOCOL_VERSION, type, ts: nowMs() };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      (env as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return env;
}
