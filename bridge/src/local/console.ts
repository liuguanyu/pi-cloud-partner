/**
 * 本地控制台（设备端）。
 *
 * 只监听 127.0.0.1，提供两样东西：
 *   1. `/device` 页面（直接复用 web 的构建产物）
 *   2. `/api/local/*` 少量接口，**由 bridge 内部持有 deviceToken 去调云端**
 *
 * 为什么页面必须由本地进程提供：
 *   设备令牌是长期凭据。若把页面放在公网域名下、令牌塞 localStorage，
 *   任何一次 XSS 都会把它偷走；而它等于"这台机器的远程控制权"。
 *   放在 localhost，令牌不出进程，页面也拿不到它。
 *
 * 为什么手机不需要连 localhost：
 *   二维码里编的是**云端**地址，手机扫码后只与公网通信。本地服务仅服务这台机器。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** 云端 HTTP 基址：把 wss://host/ws/bridge 还原成 https://host */
export function httpBase(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  return url.origin;
}

export interface ConsoleOptions {
  port: number;
  distDir: string;
  serverUrl: string;
  deviceToken: string;
  deviceName: string;
  /** bridge 自身状态，供页面展示 */
  status: () => Record<string, unknown>;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

interface PendingClaim {
  pairId: string;
  status: string;
  user?: { displayName?: string };
}

export interface ConsoleHandle {
  close: () => Promise<void>;
  url: string;
}

async function cloudCall<T>(
  base: string,
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Device ${token}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(base + path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const err = payload as { error?: string; message?: string } | undefined;
    throw new Error(`${err?.error ?? response.status}: ${err?.message ?? response.statusText}`);
  }
  return (payload ?? {}) as T;
}

export async function startConsole(opts: ConsoleOptions): Promise<ConsoleHandle> {
  const base = httpBase(opts.serverUrl);
  const distDir = resolve(opts.distDir);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);
      const path = url.pathname;

      if (path.startsWith("/api/local/")) {
        await handleApi(req, res, url, opts, base);
        return;
      }
      // 根路径直接进设备模式，省得记路径
      if (path === "/" || path === "") {
        res.writeHead(302, { location: "/device" });
        res.end();
        return;
      }
      serveStatic(res, distDir, path);
    } catch (error) {
      opts.log("本地控制台请求失败", { error: String(error), url: req.url });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal", message: String(error) }));
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolveListen());
  });

  const url = `http://127.0.0.1:${opts.port}/`;
  opts.log("本地控制台已启动", { url, dist: distDir });

  return {
    url,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

function serveStatic(res: ServerResponse, distDir: string, path: string): void {
  if (!existsSync(join(distDir, "index.html"))) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "web 尚未构建。请在仓库根执行：\n  cd web && npm install && npm run build\n然后重启 bridge。",
    );
    return;
  }

  const wanted = path === "/" ? "/index.html" : path;
  const safe = normalize(wanted).replace(/^(\.\.[/\\])+/, "");
  const file = join(distDir, safe);

  // 命中真实文件就直出；否则回落 index.html（SPA）
  if (file.startsWith(distDir) && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      // 本地控制台不做长缓存，避免改完页面看不到效果
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
    return;
  }

  res.writeHead(200, { "content-type": MIME[".html"] ?? "text/html", "cache-control": "no-store" });
  createReadStream(join(distDir, "index.html")).pipe(res);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: ConsoleOptions,
  base: string,
): Promise<void> {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  // 本地控制台只服务本机，不暴露给其它 origin
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    send(403, { error: "forbidden", message: "本地控制台只接受同源请求" });
    return;
  }

  switch (`${req.method} ${url.pathname}`) {
    case "GET /api/local/status":
      send(200, { ...opts.status(), server: base, device: opts.deviceName });
      return;

    case "POST /api/local/pair/start": {
      const created = await cloudCall<{ code: string; expiresAt: number }>(
        base,
        "/pair/request",
        opts.deviceToken,
        { method: "POST", body: {} },
      );
      // 手机扫码直接落到云端配对页，码已预填
      const claimUrl = `${base}/m?code=${created.code}`;
      send(200, { ...created, claimUrl });
      return;
    }

    case "GET /api/local/pair/pending": {
      const { pairs } = await cloudCall<{ pairs: PendingClaim[] }>(base, "/pair/current", opts.deviceToken);
      const pending = pairs.find((p) => p.status === "pending_approval") ?? null;
      const active = pairs.find((p) => p.status === "active") ?? null;
      send(200, { pending, active });
      return;
    }

    case "POST /api/local/pair/decide": {
      const body = await readJson(req);
      const pairId = String((body as { pairId?: string }).pairId ?? "");
      const decision = (body as { decision?: string }).decision === "approve" ? "approve" : "reject";
      const takeover = Boolean((body as { takeover?: boolean }).takeover);
      if (!pairId) {
        send(400, { error: "bad_request", message: "缺少 pairId" });
        return;
      }
      const result = await cloudCall<Record<string, unknown>>(base, "/pair/approve", opts.deviceToken, {
        method: "POST",
        body: { pairId, decision, takeover },
      });
      opts.log("配对决定已提交", { pairId, decision, takeover });
      send(200, result);
      return;
    }

    default:
      send(404, { error: "not_found" });
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}
