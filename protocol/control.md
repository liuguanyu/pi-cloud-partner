# 控制面命令

状态：**已定稿（v0）**

## 1. 首要约束：`/` 开头必须拦截，不能进 prompt 通道

pi 的 `prompt` 命令里，**以 `/` 开头的消息会被展开为扩展命令 / skill / 提示模板**；而 `/resume`、`/tree` 这类是 TUI 交互命令，在 RPC 模式下根本不存在。

所以 bridge 必须先做**白名单前置判定**：

```
收到用户输入
  ├─ 以 / 开头 且 命中白名单  → 走 control.exec，翻译成 pi RPC 命令，永不进 prompt
  ├─ 以 / 开头 且 未命中      → 原样作为 prompt 下发（/skill:xxx、/template、扩展命令由 pi 自己处理）
  └─ 其他                     → 普通 prompt
```

**注意**：白名单里的命令名刻意与 pi 的 TUI 斜杠命令同名同义，用户心智一致。代价是必须保证语义不漂移——pi 改了语义我们要跟。

## 2. 白名单与映射

| 命令 | 无参数（查询） | 带参数（执行） | pi RPC |
|---|---|---|---|
| `/sessions` | 列出最近会话 | — | 无（扫 `--session-dir` 读 SessionHeader） |
| `/resume` | 别名 `/sessions` | `/resume <短id\|#序号>` | `switch_session(path)` |
| `/new` | 新建会话 | `/new <name>` | `new_session` + `set_session_name` |
| `/name` | 显示当前名 | `/name <new>` | `set_session_name` |
| `/session` | 统计信息 | — | `get_session_stats` + `get_state` |
| `/tree` | 返回会话树 | — | `get_tree` |
| `/fork` | 列出可 fork 的消息 | `/fork <#n>` | `get_fork_messages` → `fork(entryId)` |
| `/clone` | — | 执行 | `clone` |
| `/compact` | — | `/compact [说明]` | `compact(raw)` |
| `/model` | 列出可用模型 | `/model <provider/id>` | `get_available_models` / `set_model` |
| `/thinking` | 列出可用档位 | `/thinking <level>` | `get_available_thinking_levels` / `set_thinking_level` |
| `/export` | — | 导出会话 | `export_html` → 上传 blob → 返回下载链接 |
| `/abort` | — | 中断当前 run | `abort`（pi 的 TUI 用 Esc，手机需要显式命令） |
| `/capacity` | 当前容量 | — | bridge 本地状态，`bridge.capacity` |

`/resume` 需要的两件事 pi 不提供，bridge 必须自建：

1. **会话枚举**：RPC 没有 `list_sessions`，只能扫 `--session-dir`，读每个 `.jsonl` 第一行的 `SessionHeader`（含 `id` / `timestamp` / `cwd` / `parentSession`），再可选读 `SessionInfoEntry` 拿名字。
2. **`sessionId → 绝对路径` 映射**：`get_state` 只给 uuid 不给路径，`switch_session` 只收路径。

## 3. 两步式约定

手机没有 TUI 的选择器，所有交互式命令统一成：**无参数 = 查询，带参数 = 执行**。

```
用户: /resume
UI:   最近会话
      1. 01a1cd9a  14:32  repo-a   修登录接口的 500   42 条
      2. 01a1cd11  11:05  repo-b   看一下构建失败      18 条
用户: /resume 2
UI:   已切换到 01a1cd11（repo-b）
```

## 4. run 未结束时的排队语义

`/resume`、`/new`、`/fork`、`/clone`、`/compact` 都会**替换或重写当前上下文**。run 进行中执行它们会导致事件流指向旧会话、手机端状态错乱。

规则：

```
run 进行中 → 命令进队列，推 control.queued
              UI 显示「将在当前任务结束后执行」
              agent_settled 后自动执行
```

- **不是 abort，也不是立即执行**
- 队列只保留最后一条同类命令（连点 3 次 `/resume 2` 只执行一次）
- `/abort` 是例外：它本身就是中断，立即生效
- 用户可以用 `/capacity` 或 UI 上的"取消排队"清空

## 5. 输入框语义（UX 强约束）

任务变成并列实体后，「输入框」有两种含义，**必须用视觉徽标显式区分**：

| 位置 | 含义 | 走哪个 op |
|---|---|---|
| 任务详情页内输入 | 继续这个任务 | `task.input`（跑到一半 → steer；已结束 → 同会话新 run） |
| 任务列表页 / 全局输入 | 新建任务 | `task.start` |

不区分会导致「以为在追问，实际开了新任务」，在并行场景下极难排查。

## 6. 错误码

| 错误 | 含义 |
|---|---|
| `not_a_git_repo` | `isolation: "worktree"` 但目标不是 git 仓库（拒绝，不降级） |
| `workspace_not_allowed` | 路径不在 bridge 白名单内 |
| `session_not_found` | `/resume` 的 id 在本地磁盘已不存在（被删/被轮转） |
| `run_in_progress` | 命令需排队，随 `control.queued` 返回 |
| `capacity_exceeded` | 内存水位超阈值，任务只能排队 |
| `unknown_command` | 白名单内但当前上下文不支持（如 `/fork` 而会话为空） |
| `ui_request_expired` | 审批已超时自动拒绝，迟到的回答被丢弃 |

## 7. 会话正文的归属

- 会话 JSONL 只在 **bridge 本地磁盘**（`~/.pi/agent/sessions/--<path>--/`）
- 手机端缓存已拉取的消息（IndexedDB），bridge 离线时可读
- **云端不存正文**，只在 `tasks` 表存标题
- 标题三级来源，优先级从高到低：

| 来源 | 存哪里 | 是否进云 |
|---|---|---|
| 用户 `/name` 主动命名的 session 名 | session 文件 `SessionInfoEntry` | **✅ 同步进云**（用户主动命名 = 显式同意公开此字符串） |
| 首句 prompt 前 80 字 | 手机 IndexedDB | ❌ 永不进云 |
| 派生弱标题 `repo-a · 14:32` | 云端 `tasks.title` | ✅（零用户输入，作为兜底） |

**`/name` 的同步规则**：bridge 执行 `set_session_name` 成功后，同时上报 `task.title_updated`；云端更新 `tasks.title`。因此 **bridge 离线时手机仍能看到用户命名过的任务**，这是分级策略里唯一“用户主动内容进云”的例外，边界清晰：只同步用户亲手输入的那一个短字符串，不同步任何 prompt/输出/文件内容。

任务结束后新开的 run 沿用同一 session 名；用户清空名字则云端回落到弱标题。

## 8. 版本协商

bridge 页面与手机页面都可能被长期缓存。握手时交换 `v`：

- 服务端 `v` 更高 → 提示「客户端已过期，请刷新」（不支持就降级只读）
- 客户端 `v` 更高 → 拒绝连接并提示升级服务端
