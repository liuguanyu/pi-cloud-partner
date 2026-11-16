/**
 * bridge 守护进程配置。
 *
 * 位置：`~/.pi/bridge/config.json`（可执行权限无关，但建议 0600）
 *
 * 凭据单独存 `~/.pi/bridge/credentials.json`（0600），由 `pcpd device create` 生成后粘贴，
 * 或通过环境变量 PCP_DEVICE_TOKEN 注入（容器/CI 场景）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeConfig {
  /** 云端 bridge 入口，形如 wss://lab.example.com/ws/bridge */
  serverUrl: string;
  /** 设备名，云端展示用 */
  name: string;
  /**
   * workspace 白名单：远程控制只能在这些目录下开任务。
   * 为空表示拒绝一切（安全默认值）。支持前缀匹配。
   */
  workspaces: string[];
  maxRunning: number;
  maxLiveChildren: number;
  idleRecycleMinutes: number;
  /** 显式指定模型。不要依赖 pi 的默认值——默认模型可能没有有效凭据。 */
  model?: string;
  sessionDir?: string;
  /** 是否加载工具审批扩展 */
  approval: boolean;
  /**
   * project trust：RPC 模式下没人能回答弹窗，必须显式给出。
   * deny（默认）= 不加载项目级 skills/settings/MCP；approve = 加载。
   */
  projectTrust: "approve" | "deny";
  heartbeatSeconds: number;
  /**
   * 终端避让：该目录的会话文件在这个窗口内被非 bridge 进程写过，
   * 就认为"人在终端里用 pi"，手机任务排队等待。0 = 关闭。
   */
  terminalBusyWindowSeconds: number;
  /**
   * 本地控制台端口（仅监听 127.0.0.1）。0 = 关闭。
   * 页面由 bridge 自己提供，deviceToken 不出这台机器。
   */
  deviceConsolePort: number;
  /** web 构建产物目录，默认 ../web/dist（相对 bridge 目录） */
  deviceConsoleDist?: string;
}

export interface Credentials {
  deviceId: string;
  deviceToken: string;
}

export function bridgeDir(): string {
  return join(homedir(), ".pi", "bridge");
}

export function configPath(): string {
  return process.env.PCP_BRIDGE_CONFIG ?? join(bridgeDir(), "config.json");
}

export function credentialsPath(): string {
  return process.env.PCP_BRIDGE_CREDENTIALS ?? join(bridgeDir(), "credentials.json");
}

const DEFAULTS: Omit<BridgeConfig, "serverUrl"> = {
  name: "bridge",
  workspaces: [],
  maxRunning: 2,
  maxLiveChildren: 4,
  idleRecycleMinutes: 10,
  approval: true,
  projectTrust: "deny",
  heartbeatSeconds: 30,
  terminalBusyWindowSeconds: 60,
  deviceConsolePort: 8788,
};

export function loadConfig(): BridgeConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(
      `缺少配置文件 ${path}\n` +
        `示例：\n${JSON.stringify(
          {
            serverUrl: "wss://your-host/ws/bridge",
            name: "office-mac",
            workspaces: [join(homedir(), "devspace")],
            maxRunning: 2,
            maxLiveChildren: 4,
            idleRecycleMinutes: 10,
            model: "provider/model-id",
            approval: true,
            projectTrust: "deny",
            heartbeatSeconds: 30,
          },
          null,
          2,
        )}`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeConfig>;
  const merged: BridgeConfig = { ...DEFAULTS, serverUrl: "", ...raw };

  if (process.env.PCP_SERVER_URL) merged.serverUrl = process.env.PCP_SERVER_URL;
  if (!merged.serverUrl) throw new Error("配置缺少 serverUrl（或设置 PCP_SERVER_URL）");
  if (!Array.isArray(merged.workspaces)) throw new Error("workspaces 必须是数组");
  if (merged.maxRunning < 1) throw new Error("maxRunning 必须 >= 1");
  if (merged.maxLiveChildren < merged.maxRunning) {
    throw new Error("maxLiveChildren 不能小于 maxRunning");
  }
  if (merged.projectTrust !== "approve" && merged.projectTrust !== "deny") {
    throw new Error('projectTrust 只能是 "approve" 或 "deny"');
  }
  return merged;
}

export function loadCredentials(): Credentials {
  const token = process.env.PCP_DEVICE_TOKEN;
  const deviceId = process.env.PCP_DEVICE_ID;
  if (token && deviceId) return { deviceToken: token, deviceId };

  const path = credentialsPath();
  if (!existsSync(path)) {
    throw new Error(
      `缺少凭据文件 ${path}\n` +
        `先在有 MySQL 的机器上执行：pcpd device create --name <设备名>\n` +
        `然后把输出的 deviceId / deviceToken 写入该文件，并 chmod 600。`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Credentials> & { deviceId?: string };
  const finalToken = token ?? raw.deviceToken;
  const finalId = deviceId ?? raw.deviceId;
  if (!finalToken || !finalId) throw new Error(`${path} 缺少 deviceId 或 deviceToken`);
  return { deviceToken: finalToken, deviceId: finalId };
}

export function saveCredentials(creds: Credentials): void {
  const dir = bridgeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
}
