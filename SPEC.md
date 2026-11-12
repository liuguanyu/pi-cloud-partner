# pi-cloud-partner 规格说明

> 在内网机器上跑 pi，用手机纯网页远程指挥它。
> 一句话定位：**不是重写 pi，是给 pi 的 stdio RPC 接口造一个网络化外壳。**

版本：v0（决策已收敛，可进入实现）
详细协议见 `protocol/`，本文件是总纲与决策登记。

---

## 1. 目标

| # | 目标 | 可验证的判据 |
|---|---|---|
| G1 | 手机随时看 agent 在干什么 | 打开网页 ≤3s 看到任务列表与实时输出 |
| G2 | 手机能下发指令并打断 | prompt / steer / abort 端到端延迟 <1s（局域网外） |
| G3 | 危险操作必须人工确认 | 高危工具调用在手机上弹窗，90s 无响应自动拒绝 |
| G4 | 代码与数据不出内网 | 云端数据库无会话正文，可拖库泄露审计 |
| G5 | 断网不丢状态 | 断 60s 重连后事件按 seq 连续补齐，无重复无缺口 |
| G6 | 一台机器可并行多任务 | 跨 workspace 并行，同 repo 用 worktree 隔离 |

## 2. 非目标（明确不做，避免范围蔓延）

- ❌ 自建模型服务 / 代理推理（pi 直连供应商）
- ❌ 云端运行 agent（工作区留在内网，只把控制面搬到云）
- ❌ 手机 App（纯网页，避免发版与审核）
- ❌ 多人协作同一任务（一个 device 同一时刻只有一个 driver，无 observer）
- ❌ 自动合并 worktree 回主分支（v0 只展示 diff 摘要，合并由人在本机做）
- ❌ 端到端加密（云端需解析事件做路由与审计；内容本就不存）
- ❌ 内网穿透的通用隧道（只服务 pi 一种后端）

## 3. 已定决策登记（含被否决方案，避免反复讨论）

| # | 决策 | 理由 | 被否决的方案 |
|---|---|---|---|
| D1 | bridge 进程直连公网 WSS | pi 进程能出网（待目标机自检确认），可获得开机自启/断线自愈 | 浏览器代持链路（标签页关闭即断、后台节流） |
| D2 | bridge = Node/TS，cloud = Go | bridge 必须 import pi 类型 + spawn；cloud 要单二进制、连接密集、blob 流、无 npm 供应链 | 全 Node（部署与供应链）；全 Go（bridge 拿不到 pi 类型） |
| D3 | 协议单一真相源 = JSON Schema，双向 codegen | 两语言两套类型必然漂移 | 手写双份类型 |
| D4 | 云端无状态，路由/游标全在 Redis | 否则加第二个实例立刻路由断裂 | 进程内存路由 |
| D5 | 存储：Redis(瞬态) + MySQL(权威元数据) + 对象存储(blob) | 授权数据不能放缓存层；公司已有 MySQL 运维资产 | SQLite（要推广就是债）、Postgres（无决定性收益） |
| D6 | 会话正文只在 bridge 磁盘 + 手机 IndexedDB | 云拖库也拿不到代码 | 云端存正文（同步复杂度高、无收益） |
| D7 | 配对三方分离：云登记 / **PC 唯一批准** / 手机申请 | 云被攻破无法伪造授权；码被猜到无法提权 | 云端批准（单点 RCE） |
| D8 | 无 observer，1 device ≤ 1 active pair（手机侧可绑 N 台 PC） | 两方同时指挥一台机器必然打架；手机多设备是产品必需 | 只读旁听（事件 fan-out、UI 复杂度） |
| D9 | 并发单位 = workspace，不是 pair | 冲突源于共享工作目录；跨目录并行本来就安全 | 每 pair 限 1 任务（过粗） |
| D10 | 同 repo 并行 = git worktree 物理隔离 | 加锁不如不并发；非 git 目录直接拒绝不静默降级 | 应用层文件锁（漏网工具仍会踩） |
| D11 | `maxRunningTasks=2` / `maxLiveChildren=4` | 每 child 实测 184MB，2 个约 430MB 起 | 3+（办公机内存压力、手机 UI 刷屏） |
| D12 | 事件单 SSE 多路复用 + per-task 游标 | HTTP/1.1 每域名最多 6 连接 | 每任务一条 SSE（迅速耗尽）、`EventSource`（无法带多游标） |
| D13 | 分级推送：聚焦任务全量，其余只推摘要 | 带宽降一个数量级，比换语言有效 10 倍 | 全量广播 |
| D14 | 控制面 `/` 命令白名单拦截，永不进 prompt | pi 的 prompt 会展开 `/xxx` 为 skill/扩展命令，语义冲突 | 直接透传（`/resume` 会被当提示词发给模型） |
| D15 | workspace = child，跨目录一律**重建子进程** | 实测：`switch_session` 会让 cwd 跟随会话，但 project trust / `.pi/skills` / settings / MCP **不重新解析** → 进入「cwd 已新、资源还是旧」的撕裂状态，agent 会在新目录里读写却不遵守那个项目的规则 | 单 child 内 `switch_session` 换目录 |
| D16 | 标题三级：用户 `/name` 同步进云、首句摘要在手机本地、弱标题兜底 | 离线也能看到命名过的任务；云只多一个用户主动输入的短字符串 | 存首句摘要（内容外泄）、只存 sessionId（不可读） |

## 4. 架构全景

```
公网
├── 云服务器 (Go, 无状态, 可水平扩展, 单二进制)
│   ├── pairing   配对码 / claim / approve 校验
│   ├── ws-hub    bridge 长连接（每台 1 条 WSS，主动外连穿透 NAT）
│   ├── sse-hub   手机下行（每台手机 1 条多路复用 SSE）
│   ├── api       上行 task / control 指令
│   ├── blob      大产物签名 URL
│   └── audit     元数据审计（无内容）
└── Redis    路由表 | per-task 游标 | 限速；MySQL  账号/设备/pair/token/审计/摘要

       ▲ WSS                            ▲ HTTPS + SSE
┌──────┴──────────────────┐    ┌────────┴──────────────┐
│ 内网机器                 │    │ 手机 · 纯网页 /m       │
│  bridge (Node/TS 常驻)   │    │  任务列表 / 时间线      │
│   ├─ 控制面拦截           │    │  审批弹窗 / 产物        │
│   ├─ workspace 白名单路由 │    │  IndexedDB 缓存        │
│   ├─ 会话枚举（扫磁盘）    │    └───────────────────────┘
│   └─ 事件 ring buffer     │
│        ├── child#1  pi --mode rpc  ← workspace A(shared)
│        ├── child#2  pi --mode rpc  ← workspace A(worktree)
│        └── child#3  pi --mode rpc  ← workspace B(shared)
│  sessions/*.jsonl  trust.json  credentials.json
└─────────────────────────┘
```

三条信任边界：**配对**（PC 仅本地批准）、**项目信任**（spawn 时决定，静默跳过是坑）、**workspace 白名单**（否则远程可 `cd` 到 `~/.ssh`）。

## 5. 仓库结构与模块边界

```
pi-cloud-partner/
├── SPEC.md                     本文件
├── protocol/                     单一真相源
│   ├── pairing.md  control.md  tasks.md
│   └── schema/*.json            → codegen: TS + Go
├── bridge/                      Node/TS 常驻服务（无对外监听端口）
│   ├── src/pi/                  JSONL 帧层：spawn、读写、背压、类型对齐
│   ├── src/queue/               workspace 锁、串行队列、容量与回收
│   ├── src/control/             / 白名单拦截、命令翻译、两步式
│   ├── src/sessions/            磁盘枚举、sessionId↔path 映射
│   ├── src/worktree/            创建/清理/分支、非 git 拒绝
│   ├── src/cloud/               WSS 客户端、重连、游标续传
│   ├── src/blob/                大对象上传
│   └── extensions/approval.ts   pi 的工具审批闸门（tool_call 钩子）
├── cloud/                       Go 单二进制
│   ├── pairing/ ws/ sse/ api/ blob/ audit/
│   ├── store/                   repository 接口 + mysql 实现
│   └── migrations/0001_init.sql
├── web/                         一个前端工程，两角色路由
│   ├── device/                  配对台 + 桌面控制台
│   └── m/                       手机端
└── tools/egress-probe.mjs       内网出网自检
```

**边界纪律**

| 规则 | 原因 |
|---|---|
| bridge 不监听任何公网端口 | 只允许出站，任何入站都是攻击面 |
| cloud 不持有会话状态 | 无状态才能水平扩展 |
| web 不直连 bridge | 一切经云，否则要处理内网直连与鉴权双份逻辑 |
| 协议变更只改 `protocol/schema` | 手改任一侧类型必然漂移 |

## 6. 云端数据模型（MySQL 8）

```sql
CREATE TABLE users (
  id BINARY(16) NOT NULL, sso_sub VARCHAR(191) NULL, display_name VARCHAR(128) NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uk_sso (sso_sub)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE devices (                          -- 一台 bridge；故意不带 user_id
  id BINARY(16) NOT NULL, name VARCHAR(128) NOT NULL,
  fingerprint CHAR(64) NOT NULL, last_seen_at BIGINT NULL, created_at BIGINT NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uk_fp (fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE pairs (
  id BINARY(16) NOT NULL, device_id BINARY(16) NOT NULL, user_id BINARY(16) NOT NULL,
  status ENUM('requested','pending_approval','active','suspended','revoked','rejected','expired') NOT NULL,
  created_at BIGINT NOT NULL, approved_at BIGINT NULL, revoked_at BIGINT NULL,
  revoked_by ENUM('mobile','device','admin','system') NULL,
  active_device_id BINARY(16) AS (IF(status='active', device_id, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_active_pair (active_device_id),   -- DB 层保证 1 device ≤ 1 active
  KEY idx_device_status (device_id, status), KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tokens (                           -- 只存哈希
  id BINARY(16) NOT NULL, kind ENUM('device','refresh') NOT NULL,
  subject_id BINARY(16) NOT NULL, hash CHAR(64) NOT NULL,
  created_at BIGINT NOT NULL, expires_at BIGINT NULL, last_used_at BIGINT NULL,
  revoked_at BIGINT NULL,
  PRIMARY KEY (id), UNIQUE KEY uk_hash (hash), KEY idx_subject (subject_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE audit_events (                     -- append-only
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, ts BIGINT NOT NULL,
  actor ENUM('mobile','device','admin','system') NOT NULL,
  action VARCHAR(48) NOT NULL,                  -- pair.claimed / task.started / ...
  pair_id BINARY(16) NULL, device_id BINARY(16) NULL, task_id BINARY(16) NULL,
  ip VARBINARY(16) NULL, ua VARCHAR(255) NULL, meta JSON NULL,
  PRIMARY KEY (id), KEY idx_ts (ts), KEY idx_pair (pair_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tasks (                            -- 摘要，非正文
  id BINARY(16) NOT NULL, pair_id BINARY(16) NOT NULL,
  workspace VARCHAR(512) NOT NULL, workspace_mode ENUM('shared','worktree') NOT NULL,
  status VARCHAR(24) NOT NULL,
  title VARCHAR(80) NOT NULL,                    -- 用户 /name 命名优先，否则弱标题 repo-a · 14:32
  started_at BIGINT NULL, settled_at BIGINT NULL,
  exit_reason VARCHAR(24) NULL, blob_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id), KEY idx_pair_time (pair_id, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE blobs (
  id BINARY(16) NOT NULL, task_id BINARY(16) NULL, pair_id BINARY(16) NOT NULL,
  kind VARCHAR(24) NOT NULL, bytes BIGINT NOT NULL, sha256 CHAR(64) NOT NULL,
  storage_key VARCHAR(512) NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uk_sha (sha256), KEY idx_expire (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

四条约定：时间一律 `BIGINT` unix 毫秒（不用 `DATETIME`，避开时区与驱动解析差异）；字符集 `utf8mb4`；主键 `BINARY(16)` uuid（不泄露规模、便于迁移）；`audit_events` 只给 SELECT/INSERT 权限。

**保留策略**：audit 90 天 / tasks 摘要 30 天 / blobs 7 天（定时 GC）/ 会话正文云端永不存。

## 7. 协议索引

| 文件 | 内容 |
|---|---|
| `protocol/schema/envelope.json` | 统一外壳：`v/type/ts/pairId/taskId/runId/epoch/seq/cmdId` |
| `protocol/schema/task.json` | Task / Capacity 模型，`task.*` 与 `pi.event` 事件清单 |
| `protocol/schema/control.json` | 下行 op（`task.start/cancel/input/focus`、`control.exec`、`resume`、`ui.response`）与控制面命令白名单 |
| `protocol/pairing.md` | 三方权责矩阵、状态机、端点、限速、凭据生命周期 |
| `protocol/control.md` | `/` 拦截规则、命令映射表、两步式、排队语义、错误码 |
| `protocol/tasks.md` | 并发模型、worktree 细节、分级推送、游标与 epoch、已否决方案 |

`pi.event` 的 `payload` **原样等于 pi 的 `JsonAgentSessionEvent`**，零翻译透传——pi 升级事件协议时白拿新字段。

## 8. 里程碑与验收标准

| 里程碑 | 内容 | 验收（可测） |
|---|---|---|
| **M0 本地冒烟** | bridge 帧层 + 审批扩展 + 会话枚举，CLI 驱动 | ✅ **已完成**：发 prompt 看到 delta；abort 114ms 生效（`aborted=true`）；审批拒绝阻断 `write`、放行则落盘；`pwd` 免审批而 `echo >` 需审批；`/sessions` 列表正确；跨目录 `/resume` 重建子进程后 `pwd` 跟随；空闲 RSS ≈184MB、冷启动 ≈490ms |
| **M1 配对 + 只读** | cloud pairing/ws-hub/sse-hub + `web/m` 只读 | ✅ **后端已完成并本地验证**：`go test ./...` 10 用例绿；实机 11 步流程确认「未批准换 token→403、手机自我批准→401、bridge 离线→503、撤销后 pairToken→401」；MySQL 生成列唯一约束实测拒绝第二个 active pair。**待办**：`web/m` 前端 |
| **M2 上行 + 审批** | `task.start/input`、`ui.response`、`control.exec` | 手机发任务并 steer；审批 90s 超时自动拒绝且 run 继续；`/resume` 切会话后事件 `epoch` 跳变正确 |
| **M3 并行 + 稳健** | workspace 锁、worktree、断线续传、容量 | 2 任务并行互不干扰；同 repo worktree 隔离（改文件不互相影响）；断网 60s 重连后 seq 连续无缺口；第 3 个任务显示排队位次 |
| **M4 推广** | 多设备、审计导出、blob GC、部署脚本 | 一台手机管 2 台 PC；blob 过期自动清理；`launchd`/`systemd` 开机自启并通过自检脚本 |

## 9. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 目标机 WSS Upgrade 被代理剥离 | bridge 连不上云 | `tools/egress-probe.mjs` 提前定性；备选 SSE+POST 长轮询 |
| 防火墙 idle timeout | 连接静默断 | 心跳 30s（探针可测出阈值），bridge 无声重连 + 游标续传 |
| project trust 静默跳过 | 项目级 skill/扩展不生效且无告警 | bridge **必须**显式传 `--approve`/`--no-approve`，并把决定暴露到手机（实测：无 override 时 `.pi/skills` 静默不加载，stderr 空） |
| 跨目录 `switch_session` 的撕裂状态 | agent 在新 cwd 里执行，却不遵守该项目的 skills/settings/MCP | D15：跨目录必须重建子进程（已实现于 M0 CLI） |
| 路径未规范化 | macOS `/tmp` → `/private/tmp` 会让同一目录生成两个会话目录（`--tmp-x--` 与 `--private-tmp-x--`）、trust 查不中 | 所有 cwd 与 session cwd 比较前先 `realpath` 规范化 |
| 远程控制被滥用 | RCE | 配对仅 PC 批准 + 高危工具审批（90s 默认拒绝）+ workspace 白名单 + 审计 |
| 手机弱网 | SSE 频繁断、状态错乱 | per-task 游标 + 快照重拉 + `epoch` 丢弃迟到帧 |
| worktree 磁盘膨胀 | 磁盘打满 | 结束后不自动删但展示占用与 diff，提供一键清理 |
| 模型默认值无凭据 | 全部请求 401，但表现为**空的 assistant 消息**，极易误判为“模型没反应” | `message_end` 必须展开 `stopReason`/`errorMessage`；bridge 显式配置模型（实测默认 `zyuncs/gpt-5.6-sol-cpr` 401，`zyuncs_in/deepseek-v4.1-flash` 正常） |
| 单实例 Redis 故障 | 全网重连 | 重连即可恢复（授权在 MySQL，不依赖 Redis） |

## 10. 开工前置

1. 在**目标内网机器**执行 `node tools/egress-probe.mjs --host <云域名> --wss-path /ws/bridge --idle 120`，确认进程直连可行（否则切 D1 的备选方案）
2. 确定云域名（自签也可先跑通）、MySQL 实例、对象存储位置
3. 登录方式若沿用长期 token，可先跑通链路，M1 末尾再补账号体系
