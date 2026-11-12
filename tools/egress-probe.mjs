#!/usr/bin/env node
/**
 * 内网机器出网能力自检（决定 bridge 走「进程直连」还是降级「浏览器代持」）
 *
 *   node tools/egress-probe.mjs --host ws.example.com --wss-path /ws/bridge --idle 120
 *
 * 无第三方依赖，要求 Node >= 22（使用全局 WebSocket）。
 */
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import dns from "node:dns/promises";
import os from "node:os";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const HOST = arg("host", "");
const WSS_PATH = arg("wss-path", "/");
const IDLE = Number(arg("idle", "0")); // 秒；0 表示跳过空闲存活测试
const TIMEOUT = Number(arg("timeout", "8000"));

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok === true ? "✅" : ok === false ? "❌" : "⚠️ "} ${name}  ${detail}`);
};

// 1. 代理环境
function checkProxyEnv() {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"];
  const found = keys.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`);
  if (found.length === 0) rec("代理环境变量", true, "无（node 将直连）");
  else rec("代理环境变量", null, `存在: ${found.join(", ")} —— 需确认该代理是否需要 NTLM 认证`);
}

// 2. DNS
async function checkDns() {
  if (!HOST) return rec("DNS 解析", null, "跳过（未提供 --host）");
  try {
    const t0 = Date.now();
    const addrs = await dns.lookup(HOST, { all: true });
    rec("DNS 解析", true, `${HOST} -> ${addrs.map((a) => a.address).join(", ")} (${Date.now() - t0}ms)`);
    return addrs;
  } catch (e) {
    rec("DNS 解析", false, `${HOST} 解析失败: ${e.code || e.message}`);
    return null;
  }
}

// 3. 裸 TCP 443（测纯 IP 层连通性）
//    note: 这是**参考项**，不计入失败——公网公共 DNS 的 443 被出口策略拦截很常见，
//    与目标域名是否可达无关。之前把它算进结论会造成误报。
function checkTcp(host, port = 443, opts = {}) {
  const { informational = false, label = `TCP ${host}:${port}` } = opts;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.createConnection({ host, port, timeout: TIMEOUT });
    s.on("connect", () => {
      rec(label, true, `连通 ${Date.now() - t0}ms`);
      s.destroy();
      resolve(true);
    });
    s.on("timeout", () => {
      rec(label, informational ? null : false, `超时 ${TIMEOUT}ms${informational ? "（参考项，不影响结论）" : "（疑似出口封锁）"}`);
      s.destroy();
      resolve(false);
    });
    s.on("error", (e) => {
      rec(label, informational ? null : false, `${e.code || e.message}${informational ? "（参考项，不影响结论）" : ""}`);
      resolve(false);
    });
  });
}

// 4. TLS 握手 + 证书链（检测 SSL 中间人）
function checkTls(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = tls.connect({ host, port: 443, servername: host, timeout: TIMEOUT }, () => {
      const cert = s.getPeerCertificate();
      const issuer = cert?.issuer?.O || cert?.issuer?.CN || "unknown";
      const selfSigned = cert?.issuer?.CN === cert?.subject?.CN;
      rec(
        `TLS 握手 ${host}`,
        !selfSigned,
        `${s.getProtocol()} ${Date.now() - t0}ms issuer="${issuer}"${selfSigned ? " ← 疑似中间人/自签，需 NODE_EXTRA_CA_CERTS" : ""}`,
      );
      s.destroy();
      resolve(true);
    });
    s.on("timeout", () => {
      rec(`TLS 握手 ${host}`, false, "超时");
      s.destroy();
      resolve(false);
    });
    s.on("error", (e) => {
      rec(
        `TLS 握手 ${host}`,
        false,
        `${e.code || e.message}${e.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || e.code === "SELF_SIGNED_CERT_IN_CHAIN" ? " ← 证书链不被信任，导出公司根 CA 用 NODE_EXTRA_CA_CERTS 指定" : ""}`,
      );
      resolve(false);
    });
  });
}

// 5. WSS Upgrade（很多代理放行 POST 但剥掉 Upgrade 头）
function checkWss(host) {
  return new Promise((resolve) => {
    const url = `wss://${host}${WSS_PATH}`;
    const t0 = Date.now();
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      rec(`WSS Upgrade ${url}`, ok, detail);
      resolve(ok);
    };
    try {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        done(null, `握手未完成（${TIMEOUT}ms）——服务端未就绪也可能，但升级被拦更常见`);
      }, TIMEOUT);
      ws.onopen = () => {
        clearTimeout(timer);
        done(true, `升级成功 ${Date.now() - t0}ms（Accept 头合法）`);
        ws.close();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        done(false, "升级失败：可能是出口代理剥掉了 Upgrade 头，或服务端拒绝");
      };
    } catch (e) {
      done(false, e.message);
    }
  });
}

// 6. 空闲长链存活（防火墙 idle timeout 决定心跳间隔）
async function checkIdle() {
  if (!IDLE || !HOST) return rec("空闲存活", null, "跳过");
  return new Promise((resolve) => {
    const url = `wss://${HOST}${WSS_PATH}`;
    let closedAt = 0;
    const t0 = Date.now();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return rec("空闲存活", null, `无法建立连接: ${e.message}`) ?? resolve();
    }
    const done = (alive) => {
      rec("空闲存活", alive, alive ? `${IDLE}s 未断` : `第 ${Math.round(closedAt / 1000)}s 被断开 → 心跳需小于该值`);
      try { ws.close(); } catch {}
      resolve();
    };
    ws.onclose = () => {
      closedAt = Date.now() - t0;
      done(false);
    };
    ws.onerror = () => {};
    setTimeout(() => done(true), IDLE * 1000);
    void t0;
  });
}

async function main() {
  console.log(`\n内网出网自检  host=${HOST || "(未指定)"}  node=${process.version}  os=${os.platform()}${os.release()}\n`);
  checkProxyEnv();
  const addrs = await checkDns();
  if (HOST && addrs?.length) {
    await checkTcp(addrs[0].address, 443, { informational: true, label: `TCP 直连 IP ${addrs[0].address}:443` });
  }
  await checkTcp("1.1.1.1", 443, { informational: true, label: "TCP 1.1.1.1:443（参考）" });
  if (HOST) {
    const ok = await checkTcp(HOST);
    if (ok) {
      await checkTls(HOST);
      await checkWss(HOST);
      await checkIdle();
    }
  }
  const hard = results.filter((r) => r.ok === false);
  console.log(
    `\n结论: ${hard.length === 0 ? "✅ 进程直连可行，bridge 走方案 B" : `❌ ${hard.length} 项不通 → 需要降级「浏览器代持链路」或配置代理/CA`}\n`,
  );
  process.exit(hard.length === 0 ? 0 : 1);
}

main();
