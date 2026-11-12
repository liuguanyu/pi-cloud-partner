/**
 * 控制面拦截。
 *
 * 硬规则：`/` 开头的输入，命中白名单 → 走这里翻译成 pi RPC 命令，**永不进入 prompt 通道**；
 * 未命中 → 原样交给 pi 当 prompt（`/skill:xxx`、`/template`、扩展命令由 pi 自己展开）。
 *
 * 两步式：无参数 = 查询（返回候选），带参数 = 执行。
 */
import { realpathSync } from "node:fs";
import type { PiClient } from "../pi/client.ts";
import {
  formatSessionList,
  listSessions,
  resolveSession,
  type SessionSummary,
} from "../sessions/index.ts";

/** 与 pi TUI 斜杠命令同名同义，见 protocol/control.md §2 */
export const CONTROL_WHITELIST = [
  "/sessions",
  "/resume",
  "/new",
  "/name",
  "/session",
  "/tree",
  "/fork",
  "/clone",
  "/compact",
  "/model",
  "/thinking",
  "/export",
  "/abort",
  "/capacity",
] as const;

const WHITELIST = new Set<string>(CONTROL_WHITELIST);

export type ParsedInput =
  | { kind: "control"; name: string; args: string[]; rawArgs: string }
  | { kind: "prompt"; text: string };

export function parseInput(raw: string): ParsedInput {
  const text = raw.trim();
  const firstSpace = text.search(/\s/);
  const head = firstSpace === -1 ? text : text.slice(0, firstSpace);
  if (head.startsWith("/") && WHITELIST.has(head)) {
    const rawArgs = firstSpace === -1 ? "" : text.slice(firstSpace).trim();
    return {
      kind: "control",
      name: head,
      args: rawArgs.length === 0 ? [] : rawArgs.split(/\s+/),
      rawArgs,
    };
  }
  return { kind: "prompt", text };
}

export interface ControlContext {
  client: PiClient;
  cwd: string;
  sessionDir?: string;
  /**
   * 换 workspace 时重建 pi 子进程（stop 旧的 + 按新 cwd spawn）。
   * 为什么必需：switch_session 会让 pi 的 cwd 跟着会话变，但 project trust、
   * `.pi/settings.json`、`.pi/skills`、项目 MCP **不会重新解析**（它们是 spawn 时决定的）。
   * 不重建就会进入“cwd 在新目录、资源还是旧的”的撕裂状态。
   */
  switchWorkspace?: (cwd: string) => Promise<PiClient>;
}

export interface ControlResult {
  ok: boolean;
  text: string;
  /** 命令执行后宿主应采用的 workspace（发生了重建才有值） */
  cwd?: string;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function execControl(
  ctx: ControlContext,
  input: { name: string; args: string[]; rawArgs: string },
): Promise<ControlResult> {
  const { client } = ctx;
  const { name, args, rawArgs } = input;

  switch (name) {
    case "/sessions":
    case "/resume": {
      const sessions = await listSessions({
        sessionDir: ctx.sessionDir,
        cwd: ctx.cwd,
        limit: 10,
      });
      if (args.length === 0) {
        return { ok: true, text: formatSessionList(sessions) };
      }
      const { session, error } = resolveSession(sessions, args[0] ?? "");
      if (!session) return { ok: false, text: error ?? "无法解析会话" };

      // 跨目录会话：cwd 会跟着变但项目资源不会重载 → 必须重建子进程
      const targetCwd = session.cwd ? canonical(session.cwd) : "";
      const sameWorkspace = targetCwd === "" || targetCwd === canonical(ctx.cwd);
      let active = ctx.client;
      if (!sameWorkspace) {
        if (!ctx.switchWorkspace) {
          return {
            ok: false,
            text: `目标会话属于 ${session.cwd}，与当前子进程工作目录不同。切换会丢失项目级 settings/skills/MCP，需要重建子进程（宿主未提供该能力）`,
          };
        }
        active = await ctx.switchWorkspace(targetCwd);
      }

      const result = await active.switchSession(session.path);
      if (result.cancelled) return { ok: false, text: "切换被扩展取消" };
      const label = session.name ?? session.firstUserText ?? session.sessionId.slice(0, 8);
      const note = sameWorkspace ? "" : `\n（已重建子进程：工作目录 → ${targetCwd}，项目级资源按新目录加载）`;
      return {
        ok: true,
        text: `已切换到 ${session.sessionId.slice(0, 8)}（${label}）${note}`,
        ...(sameWorkspace ? {} : { cwd: targetCwd }),
      };
    }

    case "/new": {
      const result = await client.newSession();
      if (result.cancelled) return { ok: false, text: "新建会话被扩展取消" };
      if (args.length > 0 && rawArgs) {
        await client.setSessionName(rawArgs);
        return { ok: true, text: `已新建会话「${rawArgs}」` };
      }
      return { ok: true, text: "已新建会话" };
    }

    case "/name": {
      if (args.length === 0) {
        const state = await client.getState();
        const sessionId = String(state.sessionId ?? "");
        const sessions = await listSessions({ sessionDir: ctx.sessionDir, cwd: ctx.cwd, limit: 200 });
        const found = sessions.find((s: SessionSummary) => s.sessionId === sessionId);
        return { ok: true, text: `当前名称：${found?.name ?? "(未命名)"}  会话 ${sessionId.slice(0, 8)}` };
      }
      await client.setSessionName(rawArgs);
      return { ok: true, text: `已命名为「${rawArgs}」（应同步到云端 tasks.title）` };
    }

    case "/session": {
      const stats = await client.getSessionStats();
      const state = await client.getState();
      const usage = stats.contextUsage as { tokens?: number; contextWindow?: number; percent?: number } | undefined;
      return {
        ok: true,
        text: [
          `会话     ${String(stats.sessionId ?? "").slice(0, 8)}`,
          `消息     用户 ${stats.userMessages ?? 0} / 助手 ${stats.assistantMessages ?? 0} / 工具 ${stats.toolCalls ?? 0}`,
          `上下文   ${usage?.tokens ?? 0} / ${usage?.contextWindow ?? 0} tokens (${usage?.percent ?? 0}%)`,
          `模型     ${String((state.model as { id?: string } | undefined)?.id ?? "?")}  思考 ${String(state.thinkingLevel ?? "?")}`,
          `状态     ${state.isStreaming ? "运行中" : "空闲"}${state.isCompacting ? " (压缩中)" : ""}`,
        ].join("\n"),
      };
    }

    case "/tree": {
      const tree = await client.getTree();
      return { ok: true, text: formatTree(tree) };
    }

    case "/fork": {
      const candidates = await client.getForkMessages();
      if (candidates.length === 0) return { ok: false, text: "当前会话没有可分叉的用户消息" };
      if (args.length === 0) {
        const lines = candidates.map((c, i) => `${String(i + 1).padStart(2)}. ${c.text.replace(/\s+/g, " ").slice(0, 70)}`);
        return { ok: true, text: `可分叉的消息：\n${lines.join("\n")}\n用 /fork <序号> 执行` };
      }
      const picked = candidates[Number(args[0]) - 1];
      if (!picked) return { ok: false, text: `序号 ${args[0]} 超出范围（共 ${candidates.length} 条）` };
      const result = await client.fork(picked.entryId);
      if (result.cancelled) return { ok: false, text: "分叉被扩展取消" };
      return { ok: true, text: `已从该消息分叉：${result.text.slice(0, 60)}` };
    }

    case "/clone": {
      const result = await client.clone();
      if (result.cancelled) return { ok: false, text: "复制被扩展取消" };
      return { ok: true, text: "已复制当前会话分支" };
    }

    case "/compact": {
      const result = await client.compact(rawArgs || undefined);
      const before = result.tokensBefore ?? "?";
      const after = result.tokensAfter ?? "?";
      return { ok: true, text: `已压缩上下文：${before} → ${after} tokens` };
    }

    case "/model": {
      const state = await client.getState();
      const current = String((state.model as { id?: string } | undefined)?.id ?? "?");
      if (args.length === 0) {
        const models = await client.getAvailableModels();
        const lines = models
          .slice(0, 20)
          .map((m) => `  ${String(m.provider)}/${String(m.id)}${String(m.id) === current ? "  ← 当前" : ""}`);
        return { ok: true, text: `当前 ${current}\n可选：\n${lines.join("\n")}` };
      }
      const spec = args[0] ?? "";
      const slash = spec.indexOf("/");
      if (slash <= 0) return { ok: false, text: "用法：/model <provider/id>" };
      await client.setModel(spec.slice(0, slash), spec.slice(slash + 1));
      return { ok: true, text: `已切换模型到 ${spec}` };
    }

    case "/thinking": {
      const levels = await client.getAvailableThinkingLevels();
      if (args.length === 0) {
        const state = await client.getState();
        return {
          ok: true,
          text: `当前 ${String(state.thinkingLevel ?? "?")}\n可选：${levels.join(", ")}`,
        };
      }
      const level = args[0] ?? "";
      if (!levels.includes(level)) return { ok: false, text: `未知档位 "${level}"，可选：${levels.join(", ")}` };
      await client.setThinkingLevel(level);
      return { ok: true, text: `思考档位已设为 ${level}` };
    }

    case "/export": {
      const result = await client.exportHtml();
      return { ok: true, text: `已导出：${result.path}（M2 起改为上传 blob 并返回签名 URL）` };
    }

    case "/abort": {
      await client.abort();
      return { ok: true, text: "已发送中断" };
    }

    case "/capacity": {
      return {
        ok: true,
        text: "M0 尚未启用队列：单 child、单 run。M3 起返回 running/maxRunning、liveChildren、排队位次",
      };
    }

    default:
      return { ok: false, text: `未实现的控制命令：${name}` };
  }
}

function formatTree(tree: Record<string, unknown>): string {
  const nodes = Array.isArray(tree.tree) ? tree.tree : [];
  if (nodes.length === 0) return "（会话树为空）";
  const lines: string[] = [];
  const walk = (list: unknown[], depth: number): void => {
    for (const raw of list) {
      const node = raw as Record<string, unknown>;
      const entry = (node.entry ?? {}) as Record<string, unknown>;
      const type = String(entry.type ?? "?");
      const id = String(entry.id ?? "").slice(0, 6);
      const leaf = String(tree.leafId ?? "").startsWith(String(entry.id ?? "~")) ? " ←" : "";
      lines.push(`${"  ".repeat(depth)}${type} ${id}${leaf}`);
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length > 0) walk(children, depth + 1);
    }
  };
  walk(nodes, 0);
  return lines.slice(0, 60).join("\n");
}
