# web（Vue 3 + Vite）

手机端界面。`/m` 与将来的 `/device` 共用同一套 `core/` 与组件。

## 运行

```bash
cd web
npm install
npm run dev      # 默认 http://localhost:5180，代理到 127.0.0.1:8787
npm run build    # 产物在 dist/，静态部署到 /srv/pcp-web
npm run typecheck
```

开发期用 `PCP_BACKEND=http://host:port npm run dev` 指向别的云服务。

## 分层（依赖严格单向，违反即视为 bug）

```
views/ + components/      Vue 组件：只渲染 + 派发用户意图
      ↓ 只依赖
composables/useBridge.ts  唯一允许 import vue 的地方：快照 → 响应式
      ↓
core/app.ts               组合根：唯一同时知道 transport / storage / store
      ↓
core/{api,sse,store,credential}.ts   互相不知道对方
      ↓
protocol/ts/wire.ts       线格式唯一真相源（与 bridge、cloud 共享）
```

五条硬约束：

| 约束 | 理由 |
|---|---|
| `core/*` 不 import `vue` | 这一层要能原样搬到 Node / 桌面端复用 |
| `sse.ts` 不认识 task 语义 | 它只负责连接、解析、重连，语义在 store 归约 |
| `store.ts` 不发请求 | 状态归约与传输正交，便于单测与回放 |
| `views/*` 不 import `api/sse` | 组件不该知道鉴权头、重连退避这回事 |
| 除组合根外没有全局单例 | 避免隐式耦合，也让测试能构造独立实例 |

## 两个和性能直接相关的实现决定

**1. 事件流不进响应式状态**

`text_delta` 每秒可达几十条。若每条都触发框架更新，手机会掉帧。
`store.ts` 把增量写进内部可变结构，最多 33ms 产出一份**不可变快照**，
Vue 侧用 `shallowRef` 只换引用。

**1.5 游标只在页面生命周期内有效**

不要把它持久化到 localStorage。游标的前提是"客户端仍持有对应状态"；
刷新后 store 是空的，带旧游标去连会让云端一条都不回放，表现为"刷新后历史全没了"。
刷新时游标必须丢失，靠云端「无游标 → 回放整个 ring」兜底。
`stream.hello.bootId` 变化时（云端重启，seq 归零）也要清空游标并重置 store。

**2. SSE 不用原生 `EventSource`**

它的 `Last-Event-ID` 只能带一个值，而我们是 per-task 游标；
也不能自定义 `Authorization` 头。所以用 `fetch` + `ReadableStream` 手解析，
重连时把 `cursors` 作为查询参数带上，缺口由云端的 ring buffer 回放。

## 交互语义（不要改错）

- **列表页的输入框 = 新建任务**（`task.start`）
- **详情页的输入框 = 继续当前任务**（`task.input`：跑到一半是 steer，已结束则同会话新 run）

这两者混掉会造成"以为在追问、实际开了新任务"，在并行场景下极难排查。
见 `protocol/control.md §5`。

## 审批弹层的三点约定

1. 默认动作是**拒绝**（fail-safe），允许必须显式点。
2. 弹层必须显示**来源任务**（`taskTitle`），避免多任务时批错对象。
3. 任务进入终态后本地立即清掉弹层——只清 approvals 列表不够，
   详情页读的是 `task.pendingApproval`（这里踩过坑）。
