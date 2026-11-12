# 任务模型与并发

状态：**已定稿（v0）**

## 1. 三层概念，不要混用

| 概念 | 定义 | 数量关系 |
|---|---|---|
| **pair** | 一台 PC ↔ 一个用户的授权关系 | 配一次，长期有效 |
| **task** | 一次「prompt → agent_settled」执行请求 | pair 下可有 N 个，排队/并行 |
| **run** | task 内的一次实际执行（含 steer/follow_up 追加） | 通常 1 个，切会话后可多代（`epoch` 递增） |
| **session** | pi 的上下文容器（JSONL 文件） | 与 task 一对一；历史 session 可被新 task 复用 |

**`/resume` 切换的是 session，不是 task**：手机端「继续一个历史会话」= 新建一个 task 绑定该 sessionId。

### 1.1 标题的来源与归属

| 优先级 | 来源 | 存哪里 | 进云 |
|---|---|---|---|
| 1 | 用户 `/name` 命名的 session 名 | session 文件 + 云端 `tasks.title` | ✅ 唯一含用户输入的字段 |
| 2 | 首句 prompt 前 80 字 | 手机 IndexedDB | ❌ |
| 3 | 派生弱标题 `repo-a · 14:32` | 云端 `tasks.title` | ✅ 零用户输入 |

`/name` 成功后 bridge 上报 `task.title_updated { source: "user" }`，云端更新 `tasks.title`——因此 bridge 离线时手机仍能看到命名过的任务。用户清空名字则回落弱标题（`source: "derived"`）。

## 2. 并发单位是 workspace，不是 pair

```
pair
 └── workspace A (shared)      → child#1   同一 workspace 内串行
 └── workspace A (worktree)    → child#2   独立工作树，可与 child#1 并行
 └── workspace B (shared)      → child#3   与 A 并行
```

| 限制 | 默认 | 作用 |
|---|---|---|
| `maxRunningTasks` | **2** | 同时执行的 run 数 |
| `maxLiveChildren` | **4** | 常驻 pi 进程数（含预热空闲） |
| `idleRecycleMinutes` | 10 | 空闲 child 回收（每个约 184MB RSS） |
| `memLimitMB` | 1200 | 所有 child RSS 之和超阈值 → 新任务强制排队并显式告知 |

把「运行中」和「活着」拆开的原因：预热复用的 child 不占执行额度。切回刚用过的 workspace 可以秒开，不用等 490ms 冷启动。

**同 workspace（shared）永远串行**，即使有空闲额度。理由：冲突源于共享工作目录，加锁不如不并发。

### 2.1 跨目录 `switch_session` 是一个陷阱（实测）

```
B 在 /tmp/wsb 启动（--no-approve）   → 无 demo 技能
switch_session 到 cwd=/tmp/wsa 的会话  → pwd 变成 /tmp/wsa      ✅ cwd 跟了
                                      → 仍然无 demo 技能            ❌ 项目资源未重载
A 直接在 /tmp/wsa 启动 + --approve    → 有 demo 技能              ✅
```

结论：`switch_session` 会让 pi 的 **cwd 跟着会话变**，但 project trust、`.pi/settings.json`、`.pi/skills`、项目 MCP **只在 spawn 时解析**。直接切过去 = agent 在新目录里读写执行，却不遵守那个项目的规则。

所以规则是：**`/resume` 的目标会话 cwd ≠ 当前 child 的 cwd 时，一律重建子进程**（stop 旧的 → 按新 cwd spawn → 再 `switch_session`）。这也正是「workspace = child」模型的自然结果。

**路径必须先 `realpath` 规范化**再比较：macOS 上 `/tmp` 是 `/private/tmp` 的软链接，不规范化会让同一目录生成两个会话目录（`--tmp-x--` 与 `--private-tmp-x--`），trust 也查不中。

## 3. worktree 隔离（`isolation: "worktree"`）

同 repo 想并行时的唯一正解不是加锁，是**物理隔离文件系统**。

### 创建

```
git -C <workspace> worktree add -b pi/<taskId> <workspace>/.pi/worktrees/<taskId> HEAD
```

- 分支名 `pi/t_01a1cd9a`，落在 `<workspace>/.pi/worktrees/`（已被 `.pi/` 惯例占用，不污染项目结构）
- 该 task 的 `workspace` 字段保留原路径，实际执行目录记在 `worktreePath`，`cwd` 用 `worktreePath`
- 因为 cwd 不同 → 天然是独立 workspace 身份 → 独立 child，复用了现有模型，无需特殊处理

### 必须显式处理的四种情况

| 情况 | 行为 |
|---|---|
| 目标不是 git 仓库 | **拒绝**，`409 not_a_git_repo`（不静默降级为 shared——用户以为隔离了其实没隔离是最坏的结果） |
| 主工作树有未提交改动 | 允许，但必须提示**未提交改动不会带入隔离任务**（worktree 基于 HEAD） |
| worktree 创建失败（磁盘/锁冲突） | task 置 `failed`，`exitReason: "worktree_failed"`，原 workspace 不受影响 |
| 任务结束 | **不自动删除**。保留 worktree + 分支，等用户决定；手机端展示 diff 摘要。自动删除 = 数据丢失风险 |

### 合并回主分支

**v0 不做自动合并。** 任务结束后手机端展示 diff 摘要 + 提示分支名，合并由用户在本机执行。

M3 可加 `control.exec: "/merge"` → 走**显式审批**（`git merge --no-ff` 属高危操作），默认关闭。

### worktree 不能解决的问题

- **资源竞争**：两个任务同时跑测试抢同一端口/数据库，照样炸。worktree 只隔离文件系统。
- **磁盘**：每个 worktree 是完整工作树（不含未提交改动）。大 repo 要监控 `.pi/worktrees/` 占用。

## 4. 任务状态机

```
queued ─┬─→ starting ─→ running ─┬─→ settled
        │                 ↑  ↓    ├─→ failed
        │       awaiting_approval ┘└─→ cancelled
        └─→ cancelled (queue_cancelled)
```

- `starting`：child 已分配、cwd 已就绪，但 prompt 尚未返回 disposition
- `awaiting_approval`：有 `ui.request` 未回答。**超时 90s 或手机离线 → 默认拒绝**（fail-safe），run 继续
- `queued`：必须带 `queuePosition`，手机显示「排队第 1 位」，不能静默等待

## 5. 事件流：单连接多路复用

**HTTP/1.1 下浏览器对同域名最多 6 个连接**，每个任务一条 SSE 会迅速耗尽。因此：

- 一台手机 → **一条 SSE**，所有任务事件混流，靠 `taskId` 区分
- 消费端用 `fetch` + `ReadableStream` 手动解析 SSE 帧（`EventSource` 无法自定义 header/body，且 `Last-Event-ID` 只能带一个值）
- 重连后先发 `resume { cursors: { t_a: 120, t_b: 45 } }`，服务端按 per-task 游标回放

### 分级推送（这是带宽的决定性因素，不靠换语言）

| 场景 | 推什么 |
|---|---|
| **聚焦任务**（`task.focus` 指定） | 全量 `pi.event`（含 message_update delta、tool_execution_*） |
| 其他任务 | 只推 `task.summary`（最后一行摘要 + 工具数 + token + 待批标记） |
| pair 级 | `task.*` 生命周期、`bridge.capacity` |

切换聚焦任务 = 发 `task.focus`，bridge 对旧任务降级、新任务升级，并回放新任务最近 N 条。

### 背压

- 慢消费者：**丢弃旧 delta，保留状态类事件**，绝不无界缓冲
- 帧上限 64KB：超出的内容（tool 输出、diff、图片）走 blob，流里只放摘要 + `blobId`
- bridge 侧 ring buffer 按 task 保留最近 500 条或 10 分钟，超出后旧事件只能靠"重拉 session 文件"补齐

## 6. 游标与 epoch

- `seq` **per-task 单调，从 1 开始**，不跨任务共享
- `epoch` 在同 task 切换 session / 复用 child 时递增，用于**丢弃迟到帧**（例如旧 run 的 `ui.request` 在新 run 开始后才到）
- 手机端发现 `epoch` 跳变 → 清空该任务本地增量状态，重拉快照

## 7. 与 pi 的映射

| 我们的动作 | pi RPC |
|---|---|
| `task.start` | 分配 child → `switch_session`/`new_session` → `prompt` |
| `task.input mode=steer` | `steer` |
| `task.input mode=follow_up` | `follow_up` |
| `task.cancel` | `abort` + 清理队列 |
| `ui.response` | `extension_ui_response` |
| `pi.event` | 原样透传 `JsonAgentSessionEvent`（零翻译） |

**一个 child 同时只有一个 run**，因此 `extension_ui_request` 只带 `id` 也能天然归因到 taskId——这是该设计送的免费好处，前提是绝不放弃「一 child 一 run」。

## 8. 已否决的方案（记录理由，避免反复讨论）

| 方案 | 否决理由 |
|---|---|
| 单 child 内多 run 并行 | 事件流 seq 交错、审批无法归因、共享 cwd 冲突 |
| 同一 workspace 直接并行 | 文件互踩、状态不可复现 |
| 按 pair 限制而非 workspace | 限制过粗，跨目录并行本来就安全 |
| 云端存会话正文 | 会话归 bridge 磁盘 + 手机缓存，云零内容 |
| 用 `EventSource` | 无法带多游标、无法自定义 header |
| 任务结束自动删 worktree | 数据丢失风险 |
