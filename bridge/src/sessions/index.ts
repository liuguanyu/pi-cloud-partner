/**
 * 会话枚举。
 *
 * pi 的 RPC 没有 list_sessions，`get_state` 也只给 sessionId 不给路径，
 * 所以本模块直接读磁盘：`<sessionDir>/--<mangled-cwd>--/<timestamp>_<uuid>.jsonl`
 *
 * 只读每个文件的**首行** SessionHeader 拿元数据；名字与首条用户消息要顺序扫描，
 * 但只为最终入选的少量会话做（文件名前缀是 ISO 时间戳，可直接倒序取 Top-N，无需 stat）。
 */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createJsonlReader } from "../pi/framing.ts";

export interface SessionSummary {
  sessionId: string;
  /** 绝对路径，可直接喂给 switch_session */
  path: string;
  cwd: string;
  createdAt: number;
  /** 用户 /name 命名的会话名 */
  name?: string;
  messageCount: number;
  /** 首条用户消息的纯文本（截断 120 字），供手机端做「强可读标题」 */
  firstUserText?: string;
  parentSession?: string;
  isCurrent: boolean;
}

export function defaultSessionDir(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions");
}

/** pi 的目录命名规则：去掉首个分隔符，把 `/`、`\`、`:` 换成 `-`。 */
export function mangledDirName(cwd: string): string {
  const stripped = cwd.replace(/^[/\\]/, "");
  return `--${stripped.replace(/[/\\:]/g, "-")}--`;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join(" ");
  }
  return "";
}

interface FileEntry {
  dir: string;
  file: string;
  path: string;
}

async function collectFiles(sessionDir: string): Promise<FileEntry[]> {
  let dirs: string[];
  try {
    dirs = await readdir(sessionDir);
  } catch {
    return [];
  }
  const files: FileEntry[] = [];
  for (const dir of dirs) {
    if (!dir.startsWith("--")) continue;
    const full = join(sessionDir, dir);
    let names: string[];
    try {
      names = await readdir(full);
    } catch {
      continue;
    }
    for (const file of names) {
      if (!file.endsWith(".jsonl")) continue;
      files.push({ dir, file, path: join(full, file) });
    }
  }
  // 文件名形如 2026-11-12T02-33-34-541Z_<uuid>.jsonl → 字典序即时间序
  files.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));
  return files;
}

interface ScanResult {
  header: Record<string, unknown> | null;
  name?: string;
  messageCount: number;
  firstUserText?: string;
}

function scanSessionFile(path: string): Promise<ScanResult> {
  return new Promise((resolve) => {
    const result: ScanResult = { header: null, messageCount: 0 };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(result);
    };

    const reader = createJsonlReader({
      onRecord: (raw) => {
        const rec = raw as Record<string, unknown>;
        if (!result.header && rec.type === "session") {
          result.header = rec;
          return;
        }
        if (rec.type === "session_info" && typeof rec.name === "string" && rec.name.trim()) {
          result.name = rec.name.trim();
          return;
        }
        if (rec.type === "message") {
          result.messageCount += 1;
          const message = rec.message as { role?: string; content?: unknown } | undefined;
          if (!result.firstUserText && message?.role === "user") {
            const text = textOfContent(message.content).replace(/\s+/g, " ").trim();
            if (text) result.firstUserText = text.slice(0, 120);
          }
        }
      },
      onMalformed: () => {
        /* 跳过坏行，不影响其余统计 */
      },
    });

    const stream = createReadStream(path, { encoding: "utf8" });
    stream.on("data", (chunk) => reader.push(String(chunk)));
    stream.on("end", () => {
      reader.flush();
      finish();
    });
    stream.on("error", finish);
  });
}

export interface ListSessionsOptions {
  sessionDir?: string;
  /** 当前 pi 的工作目录，用于标记 isCurrent */
  cwd?: string;
  limit?: number;
}

export async function listSessions(opts: ListSessionsOptions = {}): Promise<SessionSummary[]> {
  const sessionDir = opts.sessionDir ?? defaultSessionDir();
  const limit = opts.limit ?? 10;
  const currentDir = opts.cwd ? mangledDirName(opts.cwd) : null;

  const files = await collectFiles(sessionDir);
  if (files.length === 0) return [];

  // 当前目录的会话优先展示，其余按时间补齐
  const current = currentDir ? files.filter((f) => f.dir === currentDir) : [];
  const others = currentDir ? files.filter((f) => f.dir !== currentDir) : files;
  const picked = [...current, ...others].slice(0, limit);

  const summaries: SessionSummary[] = [];
  for (const entry of picked) {
    const scan = await scanSessionFile(entry.path);
    const header = scan.header ?? {};
    const sessionId = typeof header.id === "string" ? header.id : entry.file;
    const createdAt = Date.parse(String(header.timestamp ?? "")) || 0;
    const summary: SessionSummary = {
      sessionId,
      path: entry.path,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      createdAt,
      messageCount: scan.messageCount,
      isCurrent: entry.dir === currentDir,
    };
    if (scan.name) summary.name = scan.name;
    if (scan.firstUserText) summary.firstUserText = scan.firstUserText;
    if (typeof header.parentSession === "string") summary.parentSession = header.parentSession;
    summaries.push(summary);
  }
  return summaries;
}

/**
 * 把用户输入解析成会话。
 * 支持：1-based 序号（列表里看到的编号）、uuid 任意长度前缀、绝对路径。
 */
export function resolveSession(
  sessions: SessionSummary[],
  token: string,
): { session?: SessionSummary; error?: string } {
  const trimmed = token.trim();
  if (!trimmed) return { error: "用法：/resume <序号|短id|路径>" };

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    const picked = sessions[index];
    if (!picked) return { error: `序号 ${trimmed} 超出范围（共 ${sessions.length} 条）` };
    return { session: picked };
  }

  if (existsSync(trimmed)) {
    const direct = sessions.find((s) => s.path === trimmed);
    return {
      session:
        direct ?? {
          sessionId: trimmed,
          path: trimmed,
          cwd: "",
          createdAt: 0,
          messageCount: 0,
          isCurrent: false,
        },
    };
  }

  if (trimmed.length < 4) return { error: "短 id 至少 4 位，避免歧义" };
  const matches = sessions.filter((s) => s.sessionId.startsWith(trimmed));
  if (matches.length === 1) return { session: matches[0] };
  if (matches.length > 1) return { error: `"${trimmed}" 匹配到 ${matches.length} 条，请写更长一些` };
  return { error: `未找到会话 "${trimmed}"（仅在本机 ${sessions.length} 条最近会话里查找）` };
}

export function formatSessionList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return "（本机没有会话）";
  const lines = sessions.map((s, i) => {
    const when = s.createdAt ? new Date(s.createdAt).toISOString().slice(5, 16).replace("T", " ") : "?";
    const title = (s.name ?? s.firstUserText ?? "(空会话)").replace(/\s+/g, " ").slice(0, 42);
    const dir = s.cwd ? (s.cwd.split("/").filter(Boolean).pop() ?? s.cwd) : "?";
    const mark = s.isCurrent ? " *" : "";
    return `${String(i + 1).padStart(2)}. ${s.sessionId.slice(0, 8).padEnd(9)}${when}  ${dir.slice(0, 16).padEnd(17)}${title}  (${s.messageCount} 条)${mark}`;
  });
  return lines.join("\n");
}
