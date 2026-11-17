/**
 * 远程审批闸门。
 *
 * 设计目标：**只问真正需要问的**。早期实现里"含 `&&` 就不放行"导致
 * `ls -la a && echo --- && ls -la b` 这种纯读命令也要人点一次，
 * 手机上被审批弹窗淹没——这是本文件重写的原因。
 *
 * 策略（`approvalPolicy`）：
 *   strict    —— 除了只读工具，全部要问（最保守）
 *   balanced  —— 只读 + **在工作目录内写文件** 自动放行；其余要问（默认）
 *
 * 三类风险分开处理：
 *   1. 只读工具（read/grep/find/ls）与只读 shell（含 `&&`/`|` 组合）→ 放行
 *   2. 工作目录内的 write/edit → 按策略
 *   3. 其他（任意 shell 副作用、目录外路径、执行脚本、网络、git 写操作）→ 必须问
 *
 * 时间超时由 pi 侧按 timeout 自动 resolve（默认拒绝），本文件不自己计时。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "apply_patch", "patch"]);

// pcp_send：agent 把文件「发回给手机」。两种策略下都放行，理由：
//   1. 手机是本产品的信任锚（L1，只有主人能配对），发文件给手机 ≈ 交给主人，
//      不等于外泄到外部
//   2. 它不增加任何新的读权限 —— agent 本来就能 read 这些文件，pcp_send 只是
//      把「已能读」的东西传出去
//   3. 若每次都弹审批，用户会困惑「我都让它发了还让我点一次」
// 真正的副作用（上传）由 bridge 侧完成，扩展本身只读文件 + 返回标记。
const SEND_TOOLS = new Set(["pcp_send"]);

/** 只读命令白名单（按首词判定） */
const READ_ONLY_CMDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "which", "whereis",
  "file", "stat", "du", "df", "tree", "grep", "rg", "ag", "find", "fd",
  "sort", "uniq", "cut", "tr", "diff", "cmp", "comm", "jq", "basename",
  "dirname", "realpath", "readlink", "date", "whoami", "hostname", "uname",
  "true", "false", "tee_never", // tee 会写文件，留着占位但不会命中
]);

/** 只允许查询版本的命令（跑脚本会执行任意代码，必须问） */
const VERSION_ONLY_CMDS = new Set([
  "node", "npm", "pnpm", "yarn", "bun", "python", "python3", "go", "rustc",
  "tsc", "pi", "docker", "git-lfs",
]);

/** git 的只读子命令 */
const READ_ONLY_GIT = new Set([
  "status", "diff", "log", "show", "branch", "rev-parse", "ls-files",
  "blame", "shortlog", "describe", "remote", "tag", "stash", "config",
]);

/** git config 只允许读取 */
function isReadOnlyGit(args: string[]): boolean {
  const sub = args[0];
  if (!sub) return false;
  if (sub === "config") return args.includes("--get") || args.includes("-l") || args.includes("--list");
  if (sub === "stash") return args[1] === "list";
  if (sub === "remote") return args.length === 1 || args[1] === "-v" || args[1] === "show";
  if (sub === "tag") return args.length === 1 || args[1] === "-l" || args[1] === "--list";
  return READ_ONLY_GIT.has(sub);
}

const READ_ONLY_TIMEOUT_MS = 90_000;

export default function approvalExtension(pi: any): void {
  const policy = process.env.PCP_APPROVAL_POLICY === "strict" ? "strict" : "balanced";

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = String(event?.toolName ?? "unknown");
    const input = (event?.input ?? {}) as Record<string, unknown>;

    // 1) 只读工具：直接放行
    if (READ_ONLY_TOOLS.has(toolName)) return;

    // 1.5) 发送工具：放行（见 SEND_TOOLS 注释）
    if (SEND_TOOLS.has(toolName)) return;

    // 2) 工作目录内的写文件：balanced 下放行
    if (WRITE_TOOLS.has(toolName)) {
      const target = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
      if (policy === "balanced" && target && insideCwd(target, ctx)) return;
    }

    // 3) shell：只读组合放行，其余要问
    if (toolName === "bash" && isReadOnlyShell(input.command)) return;

    // 4) 其余一律问人
    if (!ctx?.hasUI) {
      return { block: true, reason: `非交互模式未获批：${toolName}` };
    }

    const allowed = await ctx.ui.confirm(
      `远程审批：${toolName}`,
      summarize(input),
      { timeout: READ_ONLY_TIMEOUT_MS },
    );
    if (!allowed) {
      return { block: true, reason: `用户拒绝或超时未响应：${toolName}` };
    }
    return undefined;
  });
}

// ── 路径判断 ──────────────────────────────────────────────────

/** 目标是否在工作目录（pi 的 cwd = 选定的 workspace）内。 */
function insideCwd(target: string, ctx: any): boolean {
  const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
  if (!cwd) return false;
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const rel = relative(cwd, abs);
  // 空串表示就是 cwd 本身；以 .. 开头表示跑到外面去了
  if (rel === "") return true;
  return !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

// ── shell 只读判定 ────────────────────────────────────────────

/**
 * 把命令行拆成"段"（按未加引号的 && || ; | 与换行）。
 * 任何一段不安全，整条就不安全。
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" || ch === "|" || ch === ";" || ch === "\n") {
      // 吞掉 && || 的第二个字符
      const next = command[i + 1];
      if ((ch === "&" || ch === "|") && next === ch) i += 1;
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 去掉 SAFE 的重定向（只允许丢弃到 /dev/null），返回 null 表示不安全。 */
function stripSafeRedirects(segment: string): string | null {
  const cleaned = segment
    .replace(/\d?>>?\s*\/dev\/null/g, " ")
    .replace(/&>>?\s*\/dev\/null/g, " ");
  // 还剩下重定向/输入重定向/进程替换 → 不安全
  if (/[<>]/.test(cleaned)) return null;
  if (/`|\$\(/.test(cleaned)) return null;
  return cleaned;
}

/** 取首词（跳过形如 FOO=bar 的环境变量前缀与 sudo 之类）。 */
function firstWord(segment: string, optionals: { args: string[] }): string | null {
  const words = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i += 1;
  const head = words[i];
  if (!head) return null;
  optionals.args = words.slice(i + 1);
  return head;
}

export function isReadOnlyShell(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const raw = command.trim();
  if (!raw) return false;

  const segments = splitSegments(raw);
  if (segments.length === 0) return false;

  for (const segment of segments) {
    const cleaned = stripSafeRedirects(segment);
    if (cleaned === null) return false;
    const holder = { args: [] as string[] };
    const head = firstWord(cleaned, holder);
    if (!head) return false;

    // 版本查询类：只认 --version / -v / -V，其它一律要问
    if (VERSION_ONLY_CMDS.has(head)) {
      const ok = holder.args.some((a) => a === "--version" || a === "-v" || a === "-V");
      if (!ok) return false;
      continue;
    }
    if (head === "git") {
      if (!isReadOnlyGit(holder.args)) return false;
      continue;
    }
    if (!READ_ONLY_CMDS.has(head)) return false;
  }
  return true;
}

// ── 展示 ──────────────────────────────────────────────────────

function summarize(input: unknown, max = 220): string {
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    text = String(input);
  }
  if (text === undefined) text = "(无参数)";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
