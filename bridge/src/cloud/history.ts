/**
 * 会话历史读取（bridge 侧）。
 *
 * 会话正文唯一的家是 pi 写的 JSONL：`~/.pi/agent/sessions/--<mangled-cwd>--/<ts>_<sessionId>.jsonl`。
 * 云端只在 ring buffer 里留最近的实时事件，重启就没了，所以"隔天看昨天的任务"
 * 必须回到磁盘取。
 *
 * 输出刻意做成**扁平的 block 列表**，与 web 的 TaskView.blocks 同构，
 * 前端拿到即可直接替换渲染，不需要再做一次归约。
 */
import { createReadStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createJsonlReader } from "../pi/framing.ts";
import { defaultSessionDir } from "../sessions/index.ts";

export interface HistoryBlock {
  kind: "text" | "thinking" | "user" | "tool" | "image" | "blobImage";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  argsText?: string;
  resultText?: string;
  isError?: boolean;
  /** image 块：内联 base64（小图）；blobImage 块：blob 引用（大图） */
  data?: string;
  mimeType?: string;
  blobId?: string;
  name?: string;
}

/** 历史回放里内联图片的 base64 上限（与 live 流一致的量级） */
const HISTORY_IMAGE_B64_LIMIT = 512 * 1024;

export interface HistoryOptions {
  sessionDir?: string;
  /**
   * 只返回该时间点之后的消息。
   *
   * 为什么需要：pi 的会话是**按 workspace 续用**的（同一个目录下的多个任务
   * 共享一个 session）。若不过滤，"回看这个任务"会把之前几轮全部显示出来，
   * 用户看到的是整段会话而不是这次任务做了什么。
   */
  sinceMs?: number;
}

export interface HistoryResult {
  blocks: HistoryBlock[];
  /** 会话文件不存在（被删/被清理/换了机器） */
  missing?: boolean;
  /** 命中条数上限，前面的内容被截断 */
  truncated?: boolean;
}

const MAX_BLOCKS = 3000;

/**
 * 按 sessionId 定位文件。
 *
 * 不依赖 cwd：模板里每天/每个目录都可能不同，直接扫一遍 sessions 根目录找
 * `<timestamp>_<sessionId>.jsonl` 最稳，也能覆盖"任务跑在别的 workspace"的情况。
 */
export async function findSessionFile(sessionId: string, sessionDir = defaultSessionDir()): Promise<string | null> {
  if (!sessionId) return null;
  let dirs: string[];
  try {
    dirs = await readdir(sessionDir);
  } catch {
    return null;
  }
  const suffix = `_${sessionId}.jsonl`;
  for (const dir of dirs) {
    if (!dir.startsWith("--")) continue;
    const full = join(sessionDir, dir);
    try {
      const names = await readdir(full);
      const hit = names.find((name) => name.endsWith(suffix));
      if (hit) return join(full, hit);
    } catch {
      continue;
    }
  }
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as { type?: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

/** 取工具调用参数：兼容 arguments(JSON 字符串) / input / args。 */
function toolArgsOf(block: unknown): unknown {
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

/** 读取会话文件并还原成 block 列表（跳过 system 与压缩等元信息条目）。 */
export async function loadSessionHistory(
  sessionId: string,
  opts: HistoryOptions = {},
): Promise<HistoryResult> {
  const path = await findSessionFile(sessionId, opts.sessionDir ?? defaultSessionDir());
  if (!path || !existsSync(path)) return { blocks: [], missing: true };

  const blocks: HistoryBlock[] = [];
  let truncated = false;
  const byToolCall = new Map<string, HistoryBlock>();

  await new Promise<void>((resolve) => {
    const reader = createJsonlReader({
      onRecord: (raw) => {
        const entry = raw as Record<string, unknown>;
        if (entry.type !== "message") return;
        // 按任务起始时间裁剪（留 2s 容差：任务记录时间与首条消息写入时间有抖动）
        if (opts.sinceMs && opts.sinceMs > 0) {
          const ts = Date.parse(String(entry.timestamp ?? ""));
          if (Number.isFinite(ts) && ts < opts.sinceMs - 2000) return;
        }
        const message = entry.message as Record<string, unknown> | undefined;
        if (!message) return;
        const role = String(message.role ?? "");

        if (role === "user") {
          const text = textOf(message.content).trim();
          if (text) blocks.push({ kind: "user", text });
          // 用户发的截图：content 里是 image 块，同样受历史帧上限约束
          const content = message.content;
          if (Array.isArray(content)) {
            for (const raw of content) {
              if (typeof raw !== "object" || raw === null) continue;
              const img = raw as { type?: unknown; data?: unknown; mimeType?: unknown };
              if (img.type === "image" && typeof img.data === "string" && img.data.length <= HISTORY_IMAGE_B64_LIMIT) {
                blocks.push({ kind: "image", data: img.data, mimeType: typeof img.mimeType === "string" ? img.mimeType : "image/png" });
              }
            }
          }
          return;
        }

        if (role === "assistant") {
          const content = message.content;
          if (!Array.isArray(content)) return;
          for (const rawBlock of content) {
            if (typeof rawBlock !== "object" || rawBlock === null) continue;
            const block = rawBlock as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
            if (block.type === "text" && block.text) {
              blocks.push({ kind: "text", text: block.text });
            } else if (block.type === "thinking" && block.text) {
              blocks.push({ kind: "thinking", text: block.text });
            } else if (block.type === "image" && typeof (block as { data?: unknown }).data === "string") {
              // 会话文件里图片是内联 base64。历史走 HTTP POST，同样有帧上限：
              // 大图不回放（live 流里它已经变成 blob 引用了，磁盘上的原件只供本地看）
              const img = block as { data: string; mimeType?: string };
              if (img.data.length <= HISTORY_IMAGE_B64_LIMIT) {
                blocks.push({ kind: "image", data: img.data, mimeType: img.mimeType ?? "image/png" });
              }
            } else if ((block.type === "toolCall" || block.type === "tool_call") && block.id) {
              const toolBlock: HistoryBlock = {
                kind: "tool",
                toolCallId: block.id,
                toolName: block.name ?? "tool",
                // pi 的 toolCall 块参数在 arguments（JSON 字符串）里，不是 input
                argsText: truncate(stringify(toolArgsOf(rawBlock)), 240),
              };
              blocks.push(toolBlock);
              byToolCall.set(block.id, toolBlock);
            }
          }
          return;
        }

        if (role === "toolResult") {
          const id = String(message.toolCallId ?? "");
          const target = byToolCall.get(id);
          const resultText = truncate(stringify(textOf(message.content)), 400);
          if (target) {
            target.resultText = resultText;
            target.isError = Boolean(message.isError);
          } else {
            blocks.push({
              kind: "tool",
              toolCallId: id,
              toolName: String(message.toolName ?? "tool"),
              argsText: "",
              resultText,
              isError: Boolean(message.isError),
            });
          }
        }
      },
      onMalformed: () => {
        /* 跳过坏行 */
      },
    });

    const stream = createReadStream(path, { encoding: "utf8" });
    stream.on("data", (chunk) => reader.push(String(chunk)));
    stream.on("end", () => {
      reader.flush();
      resolve();
    });
    stream.on("error", () => resolve());
  });

  if (blocks.length > MAX_BLOCKS) {
    truncated = true;
    blocks.splice(0, blocks.length - MAX_BLOCKS);
  }
  return truncated ? { blocks, truncated } : { blocks };
}
