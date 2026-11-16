/**
 * 「这个目录是否正被人在终端里使用」的判定。
 *
 * pi 不提供 attach、也没有 session 锁，所以只能靠**可观测信号**推断：
 * pi 每次写会话都会更新 JSONL 的 mtime。
 *
 * 判定规则：
 *   取该 workspace 对应会话目录下最新的 JSONL
 *   ├─ mtime 在窗口内 且 sessionId 不属于 bridge 自己的子进程 → 人在用
 *   └─ 否则 → 空闲
 *
 * 排除自己的子进程是必须的：bridge 跑任务时也在写同一个会话目录，
 * 不排除的话会永远判定为"忙"，串行避让就变成永久阻塞。
 *
 * 这是启发式，会误判（比如你开着 pi 但在看别的窗口）。它的目标是"别撞车"，
 * 不是"精确排他"——真正的排他需要 pi 提供锁，而它没有。
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultSessionDir, mangledDirName } from "../sessions/index.ts";

export interface BusyVerdict {
  busy: boolean;
  /** 命中的会话文件（便于日志定位） */
  sessionId?: string;
  ageMs?: number;
}

export interface BusyOptions {
  /** 窗口内有过写入即视为正在使用 */
  windowMs: number;
  /** bridge 自己子进程的 sessionId 集合，必须排除 */
  ownSessionIds: ReadonlySet<string>;
  sessionDir?: string;
  /** 额外候选路径（未归一化的原始 workspace），用于覆盖软链场景 */
  extraWorkspaces?: string[];
}

/** 从 `<timestamp>_<sessionId>.jsonl` 里取出 sessionId。 */
function sessionIdOf(fileName: string): string {
  const base = fileName.replace(/\.jsonl$/, "");
  const idx = base.indexOf("_");
  return idx >= 0 ? base.slice(idx + 1) : base;
}

/**
 * 同一目录可能对应**多个会话子目录**。
 *
 * pi 用「启动时的 cwd」来做目录名，而 bridge 会 realpath 归一化。
 * 在 macOS 上 `/tmp` 是 `/private/tmp` 的软链：人在 `/tmp/foo` 起 pi，
 * 会话落在 `--tmp-foo--`；bridge 拿着 `/private/tmp/foo` 去查就查不到 → 漏判。
 * 所以两个都查，取最新的那个。
 */
function candidateDirs(sessionRoot: string, workspace: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [workspace]) {
    const dir = join(sessionRoot, mangledDirName(candidate));
    if (!seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }
  return out;
}

export async function isWorkspaceBusyByTerminal(
  workspace: string,
  opts: BusyOptions,
): Promise<BusyVerdict> {
  if (opts.windowMs <= 0) return { busy: false };

  const sessionRoot = opts.sessionDir ?? defaultSessionDir();
  // extraWorkspaces 用于传入「未归一化的原始路径」，覆盖软链场景
  const roots = [workspace, ...(opts.extraWorkspaces ?? [])];
  const dirs = roots.flatMap((ws) => candidateDirs(sessionRoot, ws));

  let newest: { file: string; mtimeMs: number } | null = null;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const info = await stat(join(dir, name));
        if (!newest || info.mtimeMs > newest.mtimeMs) {
          newest = { file: name, mtimeMs: info.mtimeMs };
        }
      } catch {
        continue;
      }
    }
  }
  if (!newest) return { busy: false };

  const ageMs = Date.now() - newest.mtimeMs;
  if (ageMs > opts.windowMs) return { busy: false };

  const sessionId = sessionIdOf(newest.file);
  if (opts.ownSessionIds.has(sessionId)) {
    // 最新写入来自 bridge 自己 → 不是人在用
    return { busy: false, sessionId, ageMs };
  }
  return { busy: true, sessionId, ageMs };
}
