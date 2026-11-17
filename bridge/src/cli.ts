#!/usr/bin/env node
/**
 * M0 冒烟 CLI：不连云，直接驱动本机 pi，验证帧层 / 控制面 / 会话枚举 / 审批闸门。
 *
 *   node src/cli.ts                         交互式（默认当前目录）
 *   node src/cli.ts --cwd ~/devspace/foo     指定工作目录（决定 trust/settings）
 *   node src/cli.ts --once "看下这个仓库"     发一条 prompt，等 settle 后退出
 *   node src/cli.ts --selftest              跑一轮不花 token 的自检
 *
 * 选项：--session <序号|短id|路径>  --no-session  --model <p/id>  --no-approval  --session-dir <dir>
 */
import { createInterface } from "node:readline";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PiClient, isUiRequest, type PiRecord, type UiRequest } from "./pi/client.ts";
import { rewriteLargeImages } from "./cloud/image-transform.ts";
import { execControl, parseInput } from "./control/index.ts";
import { listSessions, resolveSession } from "./sessions/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPROVAL_EXTENSION = join(HERE, "..", "extensions", "approval.ts");

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function parseArgs(argv: string[]) {
  const opts = {
    cwd: process.cwd(),
    session: undefined as string | undefined,
    noSession: false,
    model: undefined as string | undefined,
    approval: true,
    sessionDir: undefined as string | undefined,
    once: undefined as string | undefined,
    selftest: false,
    /** 调试用：自动应答所有阻塞式 UI 请求，避免人工输入与时序竞态 */
    uiPolicy: "ask" as "ask" | "allow" | "deny",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const next = () => argv[++i];
    switch (arg) {
      case "--cwd":
        opts.cwd = next() ?? opts.cwd;
        break;
      case "--session":
        opts.session = next();
        break;
      case "--no-session":
        opts.noSession = true;
        break;
      case "--model":
        opts.model = next();
        break;
      case "--no-approval":
        opts.approval = false;
        break;
      case "--session-dir":
        opts.sessionDir = next();
        break;
      case "--once":
        opts.once = next();
        break;
      case "--selftest":
        opts.selftest = true;
        break;
      case "--auto-ui": {
        const value = next();
        if (value === "allow" || value === "deny" || value === "ask") opts.uiPolicy = value;
        else {
          console.error("--auto-ui 只接受 allow | deny | ask");
          process.exit(2);
        }
        break;
      }
      case "-h":
      case "--help":
        console.log(
          [
            "用法: node src/cli.ts [选项]",
            "  --cwd <dir>           pi 工作目录（决定 project trust）",
            "  --session <序号|id>   启动后切到指定会话",
            "  --no-session          不持久化会话",
            "  --model <provider/id> 指定模型",
            "  --no-approval         不加载远程审批扩展（危险，仅调试）",
            "  --session-dir <dir>   覆盖会话目录",
            "  --once <text>         发一条 prompt 后退出",
            "  --selftest            跑不花 token 的自检",
            "  --auto-ui allow|deny  自动应答审批弹窗（调试用）",
          ].join("\n"),
        );
        process.exit(0);
      default:
        if (!arg.startsWith("-")) {
          opts.once = arg;
          break;
        }
        console.error(`未知参数: ${arg}`);
        process.exit(2);
    }
  }
  return opts;
}

function buildPiArgs(opts: ReturnType<typeof parseArgs>): string[] {
  const args: string[] = [];
  if (opts.noSession) args.push("--no-session");
  if (opts.model) args.push("--model", opts.model);
  if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
  if (opts.approval) args.push("-e", APPROVAL_EXTENSION);
  return args;
}

/** 上下文被替换类命令：run 进行中必须排队到 agent_settled */
const CONTEXT_REPLACING = new Set(["/resume", "/new", "/fork", "/clone", "/compact"]);

function renderEvent(rec: PiRecord, state: { atLineStart: boolean }): void {
  switch (rec.type) {
    case "message_update": {
      const inner = rec.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        process.stdout.write(inner.delta);
        state.atLineStart = inner.delta.endsWith("\n");
      }
      return;
    }
    case "tool_execution_start": {
      if (!state.atLineStart) process.stdout.write("\n");
      state.atLineStart = true;
      process.stdout.write(C.cyan(`⚙ ${String(rec.toolName)} ${C.dim(String(rec.toolCallId ?? "").slice(0, 8))}\n`));
      return;
    }
    case "tool_execution_end": {
      const isError = Boolean(rec.isError);
      const ms = rec.durationMs === undefined ? "" : ` ${C.dim(`${String(rec.durationMs)}ms`)}`;
      process.stdout.write(
        (isError ? C.red("✗ ") : C.green("✓ ")) + String(rec.toolName) + ms + "\n",
      );
      return;
    }
    case "agent_end":
    case "agent_settled": {
      if (!state.atLineStart) process.stdout.write("\n");
      state.atLineStart = true;
      if (rec.type === "agent_settled") {
        process.stdout.write(C.green(`● settled${rec.aborted ? " (aborted)" : ""}\n`));
      }
      return;
    }
    case "extension_error": {
      process.stdout.write(C.red(`扩展错误: ${String(rec.error)} @ ${String(rec.event)}\n`));
      return;
    }
    case "client.exit": {
      process.stdout.write(C.yellow(`\npi 进程退出 code=${String(rec.code)} signal=${String(rec.signal)}\n`));
      return;
    }
    case "client.parse_error": {
      process.stdout.write(C.dim(`[坏帧] ${String(rec.raw)}\n`));
      return;
    }
    default: {
      if (isUiRequest(rec) && rec.method === "notify") {
        process.stdout.write(C.dim(`· ${String(rec.message ?? "")}\n`));
      }
    }
  }
}

function renderUiPrompt(req: UiRequest): void {
  const title = String(req.title ?? req.method);
  const message = String(req.message ?? "");
  switch (req.method) {
    case "confirm":
      process.stdout.write(`\n${C.yellow("?")} ${C.bold(title)}\n  ${message}\n  ${C.dim("[y/N]")} `);
      return;
    case "select": {
      const options = Array.isArray(req.options) ? (req.options as string[]) : [];
      process.stdout.write(`\n${C.yellow("?")} ${C.bold(title)}\n`);
      options.forEach((option, i) => process.stdout.write(`  ${i + 1}. ${option}\n`));
      process.stdout.write(`  ${C.dim("序号")} `);
      return;
    }
    default:
      process.stdout.write(`\n${C.yellow("?")} ${C.bold(title)} ${C.dim(message)}\n  ${C.dim(">")} `);
  }
}

function answerUi(req: UiRequest, line: string): { confirmed?: boolean; value?: unknown; cancelled?: boolean } {
  const text = line.trim();
  if (req.method === "confirm") {
    if (text === "") return { confirmed: false };
    return { confirmed: /^(y|yes|是|好|允许)$/i.test(text) };
  }
  if (req.method === "select") {
    const options = Array.isArray(req.options) ? (req.options as string[]) : [];
    const index = Number(text) - 1;
    if (Number.isInteger(index) && options[index] !== undefined) return { value: options[index] };
    if (options.includes(text)) return { value: text };
    return { cancelled: true };
  }
  if (text === "") return { cancelled: true };
  return { value: text };
}

async function selftest(): Promise<number> {
  const checks: Array<[string, boolean, string]> = [];
  const record = (name: string, ok: boolean, detail = "") => {
    checks.push([name, ok, detail]);
    console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  ${C.dim(detail)}` : ""}`);
  };

  // ── 纯函数检查（不依赖 pi）：live 流与历史回放共用的图片改写规则 ──
  await checkImageRewrite(record);

  const client = new PiClient({ cwd: process.cwd(), args: ["--no-session"] });
  const t0 = Date.now();
  try {
    await client.start();
    record("spawn pi 并完成握手", true, `${Date.now() - t0}ms`);

    const state = await client.getState();
    record("get_state", typeof state.sessionId === "string", String(state.sessionId));

    const sessions = await listSessions({ sessionDir: undefined, cwd: process.cwd(), limit: 5 });
    record("枚举本机会话", Array.isArray(sessions), `${sessions.length} 条`);

    const stats = await client.getSessionStats();
    record("get_session_stats", typeof stats.sessionId === "string");

    const tree = await client.getTree();
    record("get_tree", Array.isArray(tree.tree));

    const verdict = parseInput("/resume");
    record("控制面白名单拦截 /resume", verdict.kind === "control");
    const passthrough = parseInput("/skill:foo bar");
    record("未知 / 命令原样下发", passthrough.kind === "prompt");

    const abort = await client.abort();
    record("abort（空闲时应无害）", abort !== undefined || abort === undefined);

    await client.stop();
    record("有序关闭", !client.running);
  } catch (error) {
    record("自检异常", false, (error as Error).message);
    await client.stop().catch(() => {});
  }

  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${failed === 0 ? C.green("全部通过") : C.red(`${failed} 项失败`)}`);
  return failed === 0 ? 0 : 1;
}

/** 验证 rewriteLargeImages：小图内联、大图换引用、转存失败降级、无图原样。 */
async function checkImageRewrite(
  record: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const small = "a".repeat(100); // ≤ limit，应内联
  const big = "a".repeat(10_000); // > limit，应交给 process
  const limit = 512;

  // 1) 小图 + 无 process 命中
  const r1 = await rewriteLargeImages(
    [{ type: "image", data: small, mimeType: "image/png" }],
    { limit, process: () => ({ type: "blobImage", blobId: "b_x" }) },
  );
  record(
    "改写:小图保持内联",
    !r1.changed && (r1.content[0] as { data?: string } | undefined)?.data === small,
  );

  // 2) 大图 process 成功 → 换成 blobImage
  const r2 = await rewriteLargeImages(
    [{ type: "image", data: big, mimeType: "image/png" }],
    { limit, process: () => ({ type: "blobImage", blobId: "b_x" }) },
  );
  record(
    "改写:大图换 blob 引用",
    r2.changed && (r2.content[0] as { blobId?: string })?.blobId === "b_x",
  );

  // 3) 大图 process 返回 null → fallback 占位
  const r3 = await rewriteLargeImages(
    [{ type: "image", data: big, mimeType: "image/png" }],
    {
      limit,
      process: () => null,
      fallback: () => ({ type: "text", text: "占位" }),
    },
  );
  record(
    "改写:转存失败用占位",
    r3.changed && (r3.content[0] as { text?: string })?.text === "占位",
  );

  // 4) 无图片块 → 原样，changed=false
  const r4 = await rewriteLargeImages(
    [{ type: "text", text: "hi" }],
    { limit, process: () => ({ blobId: "b_x" }) },
  );
  record("改写:无图原样", !r4.changed && (r4.content[0] as { text?: string })?.text === "hi");

  // 5) 混合：小图内联 + 大图换引用 + 文本保留
  const r5 = await rewriteLargeImages(
    [
      { type: "text", text: "before" },
      { type: "image", data: small, mimeType: "image/png" },
      { type: "image", data: big, mimeType: "image/jpeg" },
    ],
    { limit, process: (b) => ({ type: "blobImage", blobId: "b_" + b.data.slice(0, 2) }) },
  );
  record(
    "改写:混合块顺序正确",
    r5.changed &&
      (r5.content[0] as { text?: string })?.text === "before" &&
      (r5.content[1] as { data?: string })?.data === small &&
      (r5.content[2] as { blobId?: string })?.blobId === "b_" + big.slice(0, 2),
  );
}

async function runDebug(client: PiClient, command: string, cwd: string): Promise<string> {
  switch (command) {
    case ":state":
      return JSON.stringify(await client.getState(), null, 2);
    case ":pwd": {
      const result = await client.bash("pwd");
      return String(result.output ?? result).trim();
    }
    case ":stderr":
      return client.getStderr().trim() || "(空)";
    default:
      return `未知调试命令 ${command}（可用 :state :pwd :stderr :q）`;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) {
    process.exit(await selftest());
    return;
  }

  const cwd = resolvePath(opts.cwd);
  let clientCwd = cwd;
  const makeClient = (workspace: string): PiClient =>
    new PiClient({
      cwd: workspace,
      args: buildPiArgs(opts),
      onStderr: (chunk) => process.stderr.write(C.dim(chunk)),
    });

  let client = makeClient(clientCwd);
  await client.start();

  const view = { atLineStart: true };
  let pendingUi: UiRequest | null = null;
  let pendingControl: { name: string; args: string[]; rawArgs: string } | null = null;

  const attach = (c: PiClient): void => {
    c.onRecord((rec) => renderEvent(rec, view));
    c.onUiRequest((req) => {
      if (opts.uiPolicy !== "ask") {
        const verdict = opts.uiPolicy === "allow";
        console.log(
          C.yellow(`[auto-ui:${opts.uiPolicy}]`) +
            ` ${String(req.method)} · ${String(req.title ?? "")} · ${String(req.message ?? "").slice(0, 120)}`,
        );
        void c.respondUi(req.id, req.method === "confirm" ? { confirmed: verdict } : { cancelled: !verdict });
        return;
      }
      pendingUi = req;
      renderUiPrompt(req);
    });
    // run 结束前排队的上下文替换命令，在这里自动执行
    c.onRecord((rec) => {
      if (rec.type !== "agent_settled" || !pendingControl) return;
      const queued = pendingControl;
      pendingControl = null;
      void execControl(
        { client: c, cwd: clientCwd, sessionDir: opts.sessionDir, switchWorkspace },
        queued,
      ).then((result) => {
        if (result.cwd) clientCwd = result.cwd;
        console.log(result.ok ? C.green(result.text) : C.red(result.text));
      });
    });
  };

  /**
   * 换 workspace = 重建子进程。
   * switch_session 会让 pi 的 cwd 跟着会话走，但 project trust / 项目 skills /
   * settings / MCP 只在 spawn 时解析——不重建就会处于“cwd 变了、资源没变”的撕裂状态。
   */
  const switchWorkspace = async (workspace: string): Promise<PiClient> => {
    const next = makeClient(workspace);
    await next.start();
    attach(next);
    const previous = client;
    client = next;
    clientCwd = workspace;
    await previous.stop();
    return next;
  };

  attach(client);

  const state = await client.getState();
  if (!opts.once) {
    console.log(
      C.bold(`bridge M0 · ${cwd}`) +
        `\n模型 ${String((state.model as { id?: string } | undefined)?.id ?? "?")} · 会话 ${String(state.sessionId ?? "").slice(0, 8)}` +
        `\n${C.dim("控制命令：/sessions /resume /new /name /session /tree /fork /clone /compact /model /thinking /export /abort")}` +
        `\n${C.dim("其它输入按 prompt 发送；:q 退出，Ctrl+C 中断当前 run")}\n`,
    );
  }

  if (opts.session) {
    const sessions = await listSessions({ sessionDir: opts.sessionDir, cwd: clientCwd, limit: 50 });
    const { session, error } = resolveSession(sessions, opts.session);
    if (!session) {
      console.error(C.red(error ?? "无法解析会话"));
    } else {
      const result = await execControl(
        { client, cwd: clientCwd, sessionDir: opts.sessionDir, switchWorkspace },
        { name: "/resume", args: [opts.session], rawArgs: opts.session },
      );
      if (result.cwd) clientCwd = result.cwd;
      console.log(result.ok ? C.green(result.text) : C.red(result.text));
    }
  }

  if (opts.once) {
    try {
      if (opts.once.startsWith(":")) {
        console.log(await runDebug(client, opts.once, clientCwd));
        await client.stop();
        return;
      }
      const parsed = parseInput(opts.once);
      if (parsed.kind === "control") {
        const result = await execControl(
          { client, cwd: clientCwd, sessionDir: opts.sessionDir, switchWorkspace },
          parsed,
        );
        console.log(result.ok ? result.text : C.red(result.text));
      } else {
        const accepted = await client.prompt(parsed.text);
        console.log(C.dim(`[${accepted.disposition}]`));
        await client.waitForIdle(300_000);
      }
    } catch (error) {
      console.error(C.red((error as Error).message));
      process.exitCode = 1;
    }
    await client.stop();
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();

  process.on("SIGINT", () => {
    if (pendingUi) {
      const req = pendingUi;
      pendingUi = null;
      void client.respondUi(req.id, { cancelled: true });
      process.stdout.write("\n");
      return;
    }
    process.stdout.write(C.yellow("\n^C 中断当前 run\n"));
    void client.abort().catch(() => {});
  });

  for (;;) {
    process.stdout.write(C.dim("› "));
    const next = await lines.next();
    if (next.done) break;
    const line = String(next.value ?? "");

    if (pendingUi !== null) {
      const req: UiRequest = pendingUi;
      pendingUi = null;
      await client.respondUi(req.id, answerUi(req, line));
      continue;
    }

    if (line.trim() === ":q" || line.trim() === ":quit") break;
    if (line.trim().startsWith(":")) {
      console.log(await runDebug(client, line.trim(), clientCwd));
      continue;
    }
    if (line.trim() === "") continue;

    const parsed = parseInput(line);
    if (parsed.kind === "prompt") {
      try {
        const now = await client.getState();
        const streaming = Boolean(now.isStreaming);
        const accepted = await client.prompt(parsed.text, undefined, streaming ? "steer" : undefined);
        console.log(C.dim(`[${accepted.disposition}${streaming ? ", steer" : ""}]`));
      } catch (error) {
        console.log(C.red((error as Error).message));
      }
      continue;
    }

    // 控制面：run 进行中的上下文替换命令排队
    const now = await client.getState();
    if (Boolean(now.isStreaming) && CONTEXT_REPLACING.has(parsed.name)) {
      pendingControl = { name: parsed.name, args: parsed.args, rawArgs: parsed.rawArgs };
      console.log(C.yellow(`已排队：${parsed.name} 将在当前任务结束后执行（control.queued）`));
      continue;
    }

    try {
      const result = await execControl(
        { client, cwd: clientCwd, sessionDir: opts.sessionDir, switchWorkspace },
        parsed,
      );
      if (result.cwd) clientCwd = result.cwd;
      console.log(result.ok ? result.text : C.red(result.text));
    } catch (error) {
      console.log(C.red((error as Error).message));
    }
  }

  rl.close();
  await client.stop();
}

await main();
