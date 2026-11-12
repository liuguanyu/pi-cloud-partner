# cloud（Go 单二进制）

pi-cloud-partner 的云端服务。**无状态**、只监听回环、TLS 与路径分流交给 nginx（部署方式见 `docs/DEPLOYMENT.md`）。

## 跑起来

```bash
cd cloud

# 方式一：内存存储 + 演示凭据（本地联调，零依赖，进程退出即清空）
go run ./cmd/pcpd serve --dev-bootstrap
#   会打印 userToken（手机 claim 用）与 deviceToken（PC 用）

# 方式二：MySQL
export PCP_MYSQL_DSN='pcp:PASS@tcp(127.0.0.1:3306)/pcp?parseTime=false&charset=utf8mb4&multiStatements=true'
go run ./cmd/pcpd serve --store mysql
go run ./cmd/pcpd device create --name office-mac   # 打印 deviceToken（仅一次）
go run ./cmd/pcpd user create   --name leon         # 打印 userToken（仅一次）

go test ./...        # 10 个用例，覆盖配对/抢码/越权/WS 中继/SSE 续传
```

## 端点

| 方法 | 路径 | 凭据 | 说明 |
|---|---|---|---|
| POST | `/pair/request` | `Device <t>` | PC 生成 6 位配对码（TTL 120s） |
| POST | `/pair/claim` | `Bearer <userToken>` | 手机认领，返回 refreshToken |
| POST | `/pair/approve` | `Device <t>` | **唯一授权动作**，可带 `takeover` |
| POST | `/pair/reject` `/pair/revoke` | Device 或 user | 拒绝 / 单方面断开 |
| GET | `/pair/current` | 任一 | 状态查询（手机轮询等批准也用它） |
| POST | `/api/session` | `Bearer <refreshToken>` | 换 12h pairToken（幂等） |
| POST | `/api/task/start` | `Bearer <pairToken>` | 启动任务，返回 taskId |
| POST | `/api/task/{taskId}/input` | 同上 | steer / follow_up |
| POST | `/api/task/{taskId}/cancel` | 同上 | 中断 |
| POST | `/api/task/focus` | 同上 | 切聚焦任务（决定推全量还是摘要） |
| GET | `/api/tasks` | 同上 | 任务摘要列表（bridge 离线也可见） |
| POST | `/api/control` | 同上 | `/resume` 等控制面命令中继 |
| POST | `/api/ui/respond` | 同上 | 审批结果回填 |
| GET | `/sse?pairId=&cursors=` | `Bearer <pairToken>` | 手机下行，单连接多路复用 |
| GET | `/ws/bridge` | `Device <t>` | bridge 长连（首帧必须 bridge.hello） |
| GET | `/healthz` | 无 | 在线数/协议版本 |

## 代码结构

```
cmd/pcpd/main.go          serve / migrate / device create / user create
internal/model            领域对象（ID、状态枚举、时间统一 unix 毫秒）
internal/protocol         线格式 Envelope + 帧类型 + BridgeHello/Welcome/Capacity
internal/auth             token 生成与 sha256 哈希（不做 bcrypt：高熵随机串）
internal/pairing          三方配对协议（request/claim/approve/revoke/session）
internal/hub              连接表 + ring buffer + 分级推送 + 背压
internal/httpapi          HTTP/SSE/WSS 入口、鉴权、限速、错误码翻译
internal/store            Store 接口 + memory（本地/测试）+ mysql（生产）
internal/store/mysql/migrations/0001_init.sql
```

## 被代码强制的安全性质（不是靠约定）

| 性质 | 强制点 |
|---|---|
| 云端无法批准配对 | 只有 `requireDevice` 通过的请求才能进 `Approve`；手机凭据走 `requireUser`，必然 401 |
| 抢码硬拒绝、无覆盖路径 | `Claim` 里 `pending_approval` 且用户不同 → `ErrAlreadyClaimed` + `pair.contested` 审计 |
| 一台 device 只有一 active pair | MySQL 生成列 `active_device_id` + `UNIQUE KEY`；memory 实现同样拒绝 |
| 远程不能 cd 到任意目录 | `task.start` 校验 `bridge.Workspaces()` 白名单 |
| bridge 不能给别人的 pair 发事件 | `ingestBridgeFrame` 校验 `pair.DeviceID == dev.ID` |
| 撤销即失效 | `Revoke` 同时撤销该 pair 的 refresh/pair token |
| 会话正文永不上云 | 云端只写任务摘要（workspace/status/title），无任何 prompt/输出字段 |
| 慢消费者不拖垮进程 | hub 订阅者队列满即丢帧，不阻塞发布 |

## 与 SPEC 的两处有意偏差（已在代码注释标注）

1. **seq 是 per-pair 而非 per-task**（`hub.Publish`）。用途相同（续传过滤 `env.TaskID == tid && seq > cursor`），但 SSE 的 `id:` 天然有序，实现更简单。
2. **`task.enqueued` 由云端发布**，而不是等 bridge 回包。手机点完立刻有反馈，bridge 之后用 `task.started` 覆盖状态。

另外 `tokens.kind` 比 SPEC 多了 `user`（M1 用长期 token 代替 SSO 登录），迁移表时已包含。

## 未实现（按里程碑）

- **M2**：`task.queued` 排队位次、`control.queued` 语义落地、审批 90s 超时兜底
- **M3**：blob 上传/签名 URL、多实例（把 hub 换 Redis pub/sub）、审计查询 API
- **M4**：SSO 登录、任务摘要保留期清理、blob GC
