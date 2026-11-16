# bridge（Node/TS 常驻服务）

把 pi 的 stdio RPC 网络化的执行侧。M0 阶段只做本机验证，还没有连云。

## 快速开始

```bash
cd bridge
node src/cli.ts --selftest            # 不花 token 的自检（推荐先跑这个）
node src/cli.ts                       # 交互式，默认当前目录
node src/cli.ts --once "/sessions"    # 跑一条命令后退出
node src/cli.ts --once "看下这个仓库"   # 发一条 prompt（会花 token）
printf '/resume 10\n:pwd\n:q\n' | node src/cli.ts   # 可脚本化驱动
```

无需 `npm install`：Node ≥ 22.18 原生跑 `.ts`（type stripping），运行时**零依赖**。
`npm run typecheck` 才需要 `typescript` 与 pi 的类型包。

## 选项

| 参数 | 说明 |
|---|---|
| `--cwd <dir>` | pi 的工作目录。**决定 project trust / settings / MCP** |
| `--session <序号\|短id\|路径>` | 启动后切到指定会话 |
| `--no-session` | 不持久化会话 |
| `--model <provider/id>` | 指定模型 |
| `--no-approval` | 不加载审批扩展（危险，仅调试） |
| `--session-dir <dir>` | 覆盖会话目录 |
| `--once <text>` | 发一条后退出 |
| `--selftest` | 不花 token 的自检 |

调试命令：`:state` `:pwd` `:stderr` `:q`

## 目录

```
src/pi/framing.ts     严格 JSONL 分帧（只按 LF，不按 U+2028/2029）
src/pi/client.ts      spawn pi + 请求响应关联 + UI 子协议 + 背压 + 有序关闭
src/sessions/index.ts 扫磁盘枚举会话、id↔path 解析（RPC 没有 list_sessions）
src/control/index.ts  / 白名单拦截、两步式、命令翻译
src/cli.ts            M0 冒烟 CLI
extensions/approval.ts pi 工具审批闸门（tool_call 钩子 + ctx.ui.confirm）
```

## 三个已实现的硬规则

**1. `/` 命令永不进 prompt 通道**
`/resume` 这类在 pi 的 `prompt` 里会被当扩展命令/skill 展开，语义冲突。命中白名单就走控制面翻译，未命中才原样下发给 pi（`/skill:xxx` 仍需由 pi 展开）。

**2. 跨目录 `/resume` 重建子进程**
实测：`switch_session` 会让 cwd 跟随会话，但 project trust / `.pi/skills` / settings / MCP **不重新解析**。不重建就会"cwd 新、资源旧"。见 `protocol/tasks.md §2.1`。

**3. run 进行中的上下文替换命令排队**
`/resume` `/new` `/fork` `/clone` `/compact` 在 run 未结束时进队列，`agent_settled` 后自动执行，并提示"将在当前任务结束后执行"。

## 审批闸门

`extensions/approval.ts` 挂在 `tool_call` 上：只读工具（`read/grep/find/ls`）与白名单 shell 命令（`ls`/`git status`/…，且不含管道与串联）直接放行，其余一律 `ctx.ui.confirm({timeout: 90s})`。

RPC 模式下这会变成 `extension_ui_request`，由 `client.onUiRequest()` 接住。**未设置处理者时自动回 `cancelled`**——否则 pi 会一直挂着等人。

早期阶段的权衡：`bash` 白名单只看首个词，不做完整解析；宁可多问一次，也不要漏放一条 `rm -rf`。

## M0 已验证（真模型端到端）

| 验收项 | 结果 |
|---|---|
| `--selftest`（spawn / get_state / 会话枚举 / stats / tree / 控制面分流 / abort / 有序关闭） | 全绿 |
| 审批**拒绝** | `write` 弹窗 → 拒绝 → 工具阻断（✗）→ 文件未创建 → 模型收到拒绝并继续，不重试 |
| 审批**放行** | 同一弹窗 → 放行 → `write` 执行 1ms → 文件内容正确 |
| 只读 shell 免审批 | `pwd` 直接放行（7ms，无弹窗）；`echo hi > f.txt` 因含 `>` 被要求审批并拒绝 |
| `abort` | 调用后 **114ms** 内 `agent_settled.aborted=true` |
| 跨目录 `/resume` | 重建子进程 → `pwd` 跟随到 `/Users/liuguanyu` → 项目级资源按新目录加载 |

### 踩到的坑：不要依赖默认模型

首次运行全部返回空 assistant 消息，展开 `message_end` 才看到
`stopReason: "error"`, `errorMessage: "401: authentication failed"`。
RPC 子进程默认解析到的是 `zyuncs/openai/gpt-5.6-sol-cpr`，而这个 provider 在当前环境的凭据无效；
显式传 `--model zyuncs_in/deepseek/deepseek-v4.1-flash` 就正常。

两个结论：
1. **空 assistant 消息不代表模型无输出**，一定要展开 `stopReason` / `errorMessage`，否则会误判成"没反应"。
2. bridge 上线后应**显式配置模型**，不要靠默认值——否则可能静默跑到一个无凭据的模型上。

## 配对（PC 侧，日常就这一条命令）

```bash
cd bridge
npm run pair                # 生成配对码 → 等手机认领 → 问你要不要批准
npm run pair -- --takeover  # 已有设备在控制时，顶替它
```

为什么需要它：**批准只能由 PC 侧发起**（云端无权批准）。这个命令用 `deviceToken`
申请配对码、轮询等待、再由本机发 approve —— 就是"人在电脑前点允许"那一下。

## 连云（daemon）

```bash
# 1) 云端创建凭据（在装有 MySQL 的机器上）
pcpd device create --name office-mac     # 打印 deviceId / deviceToken（仅一次）

# 2) 写入配置
mkdir -p ~/.pi/bridge
cat > ~/.pi/bridge/config.json <<'EOF'
{
  "serverUrl": "wss://your-host/ws/bridge",
  "name": "office-mac",
  "workspaces": ["/Users/me/devspace"],
  "maxRunning": 2,
  "maxLiveChildren": 4,
  "idleRecycleMinutes": 10,
  "model": "provider/model-id",
  "approval": true,
  "projectTrust": "deny",
  "heartbeatSeconds": 30
}
EOF
cat > ~/.pi/bridge/credentials.json <<'EOF'
{"deviceId": "...", "deviceToken": "..."}
EOF
chmod 600 ~/.pi/bridge/credentials.json

# 3) 校验配置后启动
node src/daemon.ts --once-check
node src/daemon.ts
```

环境变量覆盖：`PCP_SERVER_URL` `PCP_DEVICE_ID` `PCP_DEVICE_TOKEN`
`PCP_BRIDGE_CONFIG` `PCP_BRIDGE_CREDENTIALS`（凭据也可走 0600 文件）。

### 已端到端验证（本机 memory store + 真模型）

```
手机 task.start → 云 → bridge → pi → write 工具
  → 审批弹窗经 SSE 到手机 → 手机批准 → pi 落盘 → task.settled
产物 /tmp/pcp-e2e/hello.txt 内容 = "hi"
事件流：pair.approved → stream.hello → task.enqueued → task.started
        → pi.event ×N → ui.request → task.awaiting_approval → … → task.settled
```

### 为什么用 `ws` 而不是 Node 内置 WebSocket

内置实现是 WHATWG 严格版，**不接受自定义请求头**，而 bridge 必须带
`Authorization: Device <token>`（实测内置实现只会报 `Unexpected server response` 或无鉴权连接）。
`ws` 自身零依赖，并支持 headers / ping / 背压。

### 必须显式传 `--approve/--no-approve`

RPC 模式下没人能回答 project trust 弹窗。不传就会**静默跳过**项目级
`.pi/skills`、settings、MCP —— 表现为"我的项目技能不生效"却毫无提示。
daemon 的 `projectTrust` 字段默认 `deny`（安全），要加载项目资源显式改 `approve`。

## 下一步

- M2 剩余：worktree 隔离、`control.queued` 落地、审批 90s 超时兜底的可观测性
- M3：`src/blob/` 大产物上传、断线深缺口走 bridge ring
- `cli.ts` 里的 `pendingControl` / `switchWorkspace` 是 M2 单 child 的临时实现，将迁到 `src/queue/`
