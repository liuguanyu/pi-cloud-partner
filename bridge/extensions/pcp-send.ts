/**
 * pcp_send —— agent 把文件"发"给手机的工具。
 *
 * 分工（为什么扩展只当闸门）：
 *   扩展跑在 pi 子进程里，只知道 cwd，不知道当前任务属于哪个 pair、也没有
 *   上传器。它只负责**校验路径安全 + 返回机器可读标记**（details.pcpSend）。
 *   真正的读文件、上传云端 blob、推给手机，全由 bridge 完成 —— 它手里有
 *   workspace 绝对路径、uploader、当前任务的 pairId。
 *
 * 路径安全：
 *   - 必须在 workspace 内，或落在系统临时目录（/tmp、/var/folders ——
 *     pi 自己生成的截图常常在这里，不能挡）
 *   - 禁止目录（发的是文件）、禁止超 16MB（云端 blob 上限）
 *
 * 磁盘历史：pi 的 JSONL 不存自定义工具的 details（实测确认），所以"发过什么"
 * 由 bridge 另记 sidecar（~/.pi/bridge/artifacts/<taskId>.jsonl），回放时合并。
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { Type } from "typebox";

const MAX_BYTES = 16 * 1024 * 1024;
const IS_MAC = process.platform === "darwin";

/** 系统临时目录：pi 生成的截图/产物常在这里，允许发送。收集真实路径（macOS 的 /tmp 是符号链接）。 */
function buildTempRoots(): string[] {
  const candidates = IS_MAC
    ? ["/tmp", "/private/tmp", process.env.TMPDIR ?? ""]
    : ["/tmp", "/var/tmp"];
  const roots: string[] = [];
  for (const raw of candidates) {
    if (!raw) continue;
    roots.push(resolve(raw));
    try {
      roots.push(realpathSync(raw));
    } catch {
      /* 目录不存在就算了 */
    }
  }
  return [...new Set(roots)];
}
const TEMP_ROOTS = buildTempRoots();

export default function pcpSendExtension(pi: any): void {
  pi.registerTool({
    name: "pcp_send",
    label: "发送到手机",
    description:
      "把本机的一个文件（截图、生成的图片、日志、diff 等）发送给用户手机。" +
      "当用户要求「发给我」「发到手机」「把截图发我」，或你生成了用户需要查看的文件时，" +
      "调用此工具。path 用绝对路径。",
    parameters: Type.Object({
      path: Type.String({ description: "要发送的文件的绝对路径" }),
      note: Type.Optional(Type.String({ description: "给用户的说明" })),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<unknown> {
      const path = typeof params.path === "string" ? params.path : "";
      const note = typeof params.note === "string" ? params.note : "";
      const cwd = process.cwd();

      const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
      const verdict = checkPath(abs, cwd);
      if (verdict !== null) {
        return { content: [{ type: "text", text: `pcp_send 失败：${verdict}` }], details: { pcpSendError: verdict } };
      }
      if (!existsSync(abs)) {
        return { content: [{ type: "text", text: `pcp_send 失败：文件不存在 ${abs}` }], details: { pcpSendError: "not_found" } };
      }
      const st = statSync(abs);
      if (!st.isFile()) {
        return { content: [{ type: "text", text: `pcp_send 失败：不是普通文件 ${abs}` }], details: { pcpSendError: "not_a_file" } };
      }
      if (st.size > MAX_BYTES) {
        return {
          content: [{ type: "text", text: `pcp_send 失败：文件超过 ${MAX_BYTES / 1048576}MB（${st.size} 字节）` }],
          details: { pcpSendError: "too_large" },
        };
      }

      // 成功标记：bridge 看到 details.pcpSend 就去读取、上传、推送
      return {
        content: [{ type: "text", text: `已加入发送队列：${abs}${note ? `（${note}）` : ""}，bridge 正在上传` }],
        details: { pcpSend: { path: abs, size: st.size, note } },
      };
    },
  });
}

/** 返回 null 表示路径安全；否则返回拒绝原因。 */
function checkPath(abs: string, cwd: string): string | null {
  const roots = [resolve(cwd), ...TEMP_ROOTS];
  const inside = roots.some(
    (root) => abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep),
  );
  if (!inside) {
    return `路径 ${abs} 不在工作目录或临时目录内，拒绝发送`;
  }
  return null;
}
