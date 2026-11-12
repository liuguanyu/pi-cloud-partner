/**
 * 远程审批闸门（M0）
 *
 * 挂到 pi 的 `tool_call` 事件上：只读工具直接放行，其余一律要求确认。
 * 在 RPC 模式下 `ctx.ui.confirm` 会变成 `extension_ui_request` 发到 bridge，
 * 由 bridge 转给手机；超时由 pi 侧按 timeout 自动 resolve，bridge 不需要自己计时。
 *
 * 加载方式：pi -e ./extensions/approval.ts
 * 注意：本文件**不 import 任何运行时模块**，避免扩展加载时的依赖解析问题。
 */

/** 只读工具：不产生副作用，直接放行 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** bash 里可判定的只读命令（命中即放行，注意只看首个词与子命令，不做完整解析） */
const SAFE_SHELL_PREFIXES = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "which",
  "node -v",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "rg",
  "grep",
  "find",
];

const CONFIRM_TIMEOUT_MS = 90_000;

function isSafeShell(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const normalized = command.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return false;
  // 含管道/重定向/命令串联/子 shell 一律不算只读——避免 `cat x && rm -rf y` 蒙混过关
  if (/[|;&><`$()]/.test(normalized)) return false;
  return SAFE_SHELL_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
  );
}

/** 把工具入参压成一行摘要，供手机端弹窗展示 */
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

export default function approvalExtension(pi: any): void {
  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = String(event?.toolName ?? "unknown");
    const input = event?.input ?? {};

    if (READ_ONLY_TOOLS.has(toolName)) return;
    if (toolName === "bash" && isSafeShell((input as { command?: unknown }).command)) return;
    // 非交互模式下没法问人：默认拒绝，宁可失败也不静默放行
    if (!ctx?.hasUI) {
      return { block: true, reason: `非交互模式未获批：${toolName}` };
    }

    const allowed = await ctx.ui.confirm(
      `远程审批：${toolName}`,
      summarize(input),
      { timeout: CONFIRM_TIMEOUT_MS },
    );

    if (!allowed) {
      return { block: true, reason: `用户拒绝或超时未响应：${toolName}` };
    }
    return undefined;
  });
}
