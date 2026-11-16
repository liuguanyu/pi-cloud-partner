#!/usr/bin/env node
/**
 * 配对命令（PC 侧）。
 *
 *   node src/pair.ts              生成配对码 → 等手机认领 → 交互式确认
 *   node src/pair.ts --yes        自动批准（脚本/测试用）
 *   node src/pair.ts --takeover   已有生效配对时允许顶替
 *
 * 为什么必须有这个命令：
 *   **批准只能在 PC 侧完成**（云端无权批准，见 protocol/pairing.md §1）。
 *   没有它，每次配对都得 SSH 到服务器手敲 curl。
 *
 * 它只做三件事，全部走 HTTP，不碰 pi 进程：
 *   1) 用 deviceToken 申请配对码
 *   2) 轮询等手机认领（pending_approval）
 *   3) 由**本机**发出 approve —— 这就是"人在电脑前点允许"的那一下
 */
import { createInterface } from "node:readline/promises";
import { loadConfig, loadCredentials } from "./cloud/config.ts";

interface PairView {
  pairId: string;
  status: string;
  device?: { deviceId: string; name: string; online: boolean };
  user?: { userId: string; displayName: string };
}

const args = process.argv.slice(2);
const autoYes = args.includes("--yes") || args.includes("-y");
const takeover = args.includes("--takeover");

/** 把 wss://host/ws/bridge 还原成 https://host */
function httpBase(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  return url.origin;
}

async function call<T>(base: string, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.token) headers.Authorization = `Device ${init.token}`;
  if (init.body) headers["Content-Type"] = "application/json";

  const response = await fetch(base + path, { ...init, headers });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const err = payload as { error?: string; message?: string } | undefined;
    throw new Error(`${err?.error ?? response.status}: ${err?.message ?? response.statusText}`);
  }
  return (payload ?? {}) as T;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const creds = loadCredentials();
  const base = httpBase(cfg.serverUrl);

  console.log(`设备    ${cfg.name} (${creds.deviceId.slice(0, 8)}…)`);
  console.log(`云端    ${base}`);

  const existing = await call<{ pairs: PairView[] }>(base, "/pair/current", {
    method: "GET",
    token: creds.deviceToken,
  });
  const active = existing.pairs.find((p) => p.status === "active");
  if (active) {
    const who = active.user?.displayName ?? "未知用户";
    console.log(`\n⚠ 当前已有一台设备在控制：${who} (${active.pairId})`);
    if (!takeover) {
      console.log("  继续配对会顶掉它。确认要换设备请加 --takeover 重试。");
      process.exit(2);
    }
    console.log("  已指定 --takeover，批准后将断开旧设备。");
  }

  const created = await call<{ code: string; expiresAt: number }>(base, "/pair/request", {
    method: "POST",
    token: creds.deviceToken,
    body: JSON.stringify({}),
  });

  const ttl = Math.max(0, Math.round((created.expiresAt - Date.now()) / 1000));
  console.log(`\n配对码   ${created.code}    ${ttl}s 内有效、一次性`);
  console.log(`手机     打开 ${base} ，输入该码，然后「申请接管」`);
  console.log("\n等待手机认领…（Ctrl+C 取消）");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const deadline = created.expiresAt;

  let pending: PairView | undefined;
  while (Date.now() < deadline) {
    const { pairs } = await call<{ pairs: PairView[] }>(base, "/pair/current", {
      method: "GET",
      token: creds.deviceToken,
    });
    pending = pairs.find((p) => p.status === "pending_approval");
    if (pending) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  if (!pending) {
    console.log("配对码已过期或没人认领。重新运行本命令生成新码。");
    rl.close();
    process.exit(1);
  }

  const who = pending.user?.displayName ?? "某个用户";
  console.log(`\n收到申请：${who} 请求接管这台机器 (${pending.pairId})`);

  let approve = autoYes;
  if (!autoYes) {
    const answer = await rl.question("批准？[y/N] ");
    approve = /^y(es)?$/i.test(answer.trim());
  }
  rl.close();

  if (!approve) {
    await call(base, "/pair/approve", {
      method: "POST",
      token: creds.deviceToken,
      body: JSON.stringify({ pairId: pending.pairId, decision: "reject" }),
    });
    console.log("已拒绝。");
    return;
  }

  const result = await call<{ pairId: string; status: string; takeover?: boolean }>(base, "/pair/approve", {
    method: "POST",
    token: creds.deviceToken,
    body: JSON.stringify({ pairId: pending.pairId, decision: "approve", takeover: true }),
  });

  console.log(`\n✅ 已批准：${result.pairId} → ${result.status}`);
  if (result.takeover) console.log("   （旧设备已被断开）");
  console.log("   手机端会自动跳转到任务列表。");
}

await main();
