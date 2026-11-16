#!/usr/bin/env node
/**
 * bridge 守护进程：把本机 pi 接到云端。
 *
 *   node src/daemon.ts                 # 读 ~/.pi/bridge/config.json + credentials.json
 *   node src/daemon.ts --once-check    # 只校验配置与凭据后退出
 *
 * 环境变量覆盖：
 *   PCP_SERVER_URL  PCP_DEVICE_ID  PCP_DEVICE_TOKEN
 *   PCP_BRIDGE_CONFIG  PCP_BRIDGE_CREDENTIALS
 *
 * 职责边界：
 *   - 连接/重连/心跳 → CloudClient
 *   - 任务排队与 pi 子进程 → Runner
 *   - 本文件只做「帧分发」和生命周期
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudClient, type CloudStatus } from "./cloud/client.ts";
import { loadConfig, loadCredentials } from "./cloud/config.ts";
import { Down, Up, envelope, type Envelope } from "./cloud/protocol.ts";
import { Runner, type TaskRequest } from "./cloud/runner.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPROVAL_EXTENSION = resolve(HERE, "..", "extensions", "approval.ts");

function log(msg: string, data?: Record<string, unknown>): void {
  const stamp = new Date().toISOString().slice(11, 19);
  const extra = data && Object.keys(data).length > 0 ? " " + JSON.stringify(data) : "";
  console.log(`${stamp} ${msg}${extra}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onceCheck = args.includes("--once-check");

  const cfg = loadConfig();
  const creds = loadCredentials();

  log("配置就绪", {
    server: cfg.serverUrl,
    device: cfg.name,
    workspaces: cfg.workspaces.length,
    maxRunning: cfg.maxRunning,
    trust: cfg.projectTrust,
    approval: cfg.approval,
    terminalAvoidance: cfg.terminalBusyWindowSeconds > 0 ? `${cfg.terminalBusyWindowSeconds}s` : "off",
  });

  if (cfg.workspaces.length === 0) {
    throw new Error("workspaces 为空：远程控制需要显式白名单，拒绝一切是默认行为");
  }
  if (!cfg.model) {
    log("警告：未配置 model，将使用 pi 的默认模型（可能没有有效凭据，表现为空回复）");
  }
  if (!cfg.approval) {
    log("警告：approval=false，工具调用不再需要人工确认");
  }

  if (onceCheck) {
    log("配置与凭据校验通过");
    return;
  }

  const runner = new Runner({
    workspaces: cfg.workspaces,
    maxRunning: cfg.maxRunning,
    maxLiveChildren: cfg.maxLiveChildren,
    idleRecycleMs: cfg.idleRecycleMinutes * 60_000,
    model: cfg.model,
    sessionDir: cfg.sessionDir,
    approvalExtension: cfg.approval ? APPROVAL_EXTENSION : undefined,
    projectTrust: cfg.projectTrust,
    terminalBusyWindowMs: cfg.terminalBusyWindowSeconds * 1000,
    onUp: (env) => {
      if (!client.send(env)) {
        // 离线时上行帧直接丢弃：这些事件属于实时流，桥接侧有 ring buffer 兜底
        log("上行丢弃（离线）", { type: env.type });
      }
    },
    log,
  });

  const client = new CloudClient({
    url: cfg.serverUrl,
    deviceToken: creds.deviceToken,
    deviceId: creds.deviceId,
    deviceName: cfg.name,
    workspaces: cfg.workspaces,
    maxRunning: cfg.maxRunning,
    getLiveChildren: () => runner.capacity().liveChildren,
    heartbeatMs: cfg.heartbeatSeconds * 1000,
    onStatus: (status: CloudStatus, detail?: string) => {
      log(`连接状态 → ${status}`, detail ? { detail } : undefined);
      if (status === "online") {
        // 重连后立刻对账：云端 tasks 表是缓存，断连期间会变旧。
        // 每次连上都发（幂等），云端据此校正状态、重建审批弹层。
        const { tasks } = runner.snapshot();
        client.send(envelope(Up.stateSnapshot, { payload: { tasks } }));
        log("已上报状态快照", { tasks: tasks.length });
      }
    },
    onFrame: (env) => void handleFrame(env),
    log,
  });

  async function handleFrame(env: Envelope): Promise<void> {
    switch (env.type) {
      case Down.taskStart: {
        const payload = (env.payload ?? {}) as {
          prompt?: string;
          workspace?: string;
          isolation?: string;
          images?: unknown[];
        };
        if (!env.taskId || !payload.prompt || !payload.workspace) {
          log("task.start 缺字段，忽略", { taskId: env.taskId });
          return;
        }
        const req: TaskRequest = {
          taskId: env.taskId,
          pairId: env.pairId ?? "",
          workspace: payload.workspace,
          prompt: payload.prompt,
          isolation: payload.isolation ?? "shared",
          images: payload.images,
        };
        const result = runner.submit(req);
        log("收到任务", { taskId: env.taskId, workspace: payload.workspace, accepted: result.accepted, reason: result.reason });
        if (!result.accepted) {
          client.send(
            envelope(Up.taskFailed, {
              pairId: env.pairId,
              taskId: env.taskId,
              payload: { exitReason: result.reason ?? "rejected" },
            }),
          );
        }
        return;
      }

      case Down.taskInput: {
        const payload = (env.payload ?? {}) as { text?: string; mode?: "steer" | "follow_up"; taskId?: string };
        const taskId = payload.taskId ?? env.taskId ?? "";
        const ok = runner.input(taskId, payload.text ?? "", payload.mode === "follow_up" ? "follow_up" : "steer");
        log("任务输入", { taskId, mode: payload.mode, ok });
        return;
      }

      case Down.taskCancel: {
        const taskId = env.taskId ?? ((env.payload as { taskId?: string } | undefined)?.taskId ?? "");
        const ok = runner.cancel(taskId);
        log("取消任务", { taskId, ok });
        return;
      }

      case Down.taskFocus: {
        const taskId = (env.payload as { taskId?: string } | undefined)?.taskId ?? null;
        runner.focus(taskId);
        log("切换聚焦任务", { taskId: taskId ?? "(清空)" });
        return;
      }

      case Down.uiResponse: {
        const payload = (env.payload ?? {}) as {
          requestId?: string;
          value?: unknown;
          confirmed?: boolean;
          cancelled?: boolean;
        };
        if (!payload.requestId) return;
        const ok = runner.respondUi(payload.requestId, {
          value: payload.value,
          confirmed: payload.confirmed,
          cancelled: payload.cancelled,
        });
        log("审批回填", { requestId: payload.requestId, ok });
        return;
      }

      case Down.controlExec: {
        const payload = (env.payload ?? {}) as { name?: string; args?: string[]; raw?: string };
        if (!payload.name) return;
        const result = await runner.control(payload.name, payload.args ?? [], payload.raw ?? "");
        client.send(
          envelope(Up.controlResult, {
            pairId: env.pairId,
            payload: { name: payload.name, ok: result.ok, text: result.text },
          }),
        );
        log("控制命令", { name: payload.name, ok: result.ok });
        return;
      }

      case Down.historyGet: {
        const payload = (env.payload ?? {}) as { taskId?: string; sessionId?: string; sinceMs?: number };
        if (payload.taskId && payload.sessionId) {
          await runner.history({
            taskId: payload.taskId,
            sessionId: payload.sessionId,
            sinceMs: payload.sinceMs,
            // 回显请求方给的 pairId：daemon 重启后本地不认识旧任务
            pairId: env.pairId ?? "",
          });
        } else {
          log("history.get 缺字段，忽略", { taskId: payload.taskId });
        }
        return;
      }

      case Down.resume:
        // M2：云端自己维护 ring buffer 负责回放，桥接侧暂不处理深缺口
        log("resume 已忽略（云端 ring buffer 负责回放）");
        return;

      default:
        log("未处理的帧类型", { type: env.type });
    }
  }

  client.start();
  await client.whenOnline();
  log("已连接云端", { pairs: client.welcome?.pairIds.length ?? 0 });

  // 启动即上报一次容量，手机端好显示 0/2
  client.send(envelope(Up.capacity, { payload: runner.capacity() }));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${signal}，正在关闭`);
    client.stop();
    await runner.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 常驻：CloudClient 自己负责重连
  await new Promise<void>(() => {});
}

await main();
