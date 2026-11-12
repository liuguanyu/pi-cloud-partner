# 配对协议（Pairing）

状态：**已定稿（v0，除末尾 1 项待确认）**

## 0. 术语

- **pair**：一次「某台 PC 上的 bridge ↔ 某个手机用户」的控制授权关系。一个 device 同时**最多一个 active pair**。
- **claim**：手机持配对码向云端「认领」配对请求的动作。仅补充申请人身份，**不产生任何权限**。
- **approve**：PC 本地的人在页面上点击确认。**这是唯一的授权动作。**
- **driver**：pair 中唯一有权下发命令的一方（就是手机）。**没有 observer / 只读角色**（v0 明确不做）。

## 1. 三方权责

一句话：**云只能登记不能批准，PC 只能批准不能路由，手机只能申请不能自批。**

| 数据 | 手机 | 云 | PC（bridge + /device 页面） |
|---|---|---|---|
| 配对码 | ✗ | 暂存（TTL 120s） | **生成 + 本地显示** |
| pair 状态机 | 只读副本 | **权威** | 副本 |
| pairId → PC 连接路由 | ✗ | **权威**（Redis） | ✗ |
| pairToken | **持有** | 签发 + 校验 | **持有** |
| approve / reject | ✗ | ✗（**不允许**） | **唯一有权** |
| revoke | 可（单方面） | 可（管理/风控） | 可（单方面） |

设计意图：云被攻破无法伪造授权；配对码被猜中无法提权（只让你进待批列表）；手机丢失任一方可单方面断开。

## 2. 状态机（云端权威）

```
requested ──claim──> pending_approval ──approve──> active
    │                     │
    │                     └──reject────> rejected
    └──(TTL 120s)────────> expired

active ──bridge 心跳丢失 >10min──> suspended ──重连──> active
active ──任一方 revoke───────────> revoked
active ──新 pair approve（顶替）─> revoked（旧的）
```

- `suspended` 必须有：笔记本合盖、Wi-Fi 切换不该让 pair 失效，否则每次都要重扫码。判定 = 心跳 + 宽限期 10 分钟。
- `rejected` / `revoked` 都是终态，重新控制必须走完整配对流程。

## 3. 端点

### 3.1 申请配对（PC 侧）

```
POST /pair/request           Authorization: Device <deviceToken>
→ 201 { code: "7K3M9Q", expiresAt, qrUrl }
```

- `code`：6 位 Crockford Base32（去易混字符 0/O/1/I/L）。
- 一个 device 同时只允许存在 **1 个未使用 code**；重复请求返回同一个（幂等），除非已过期。

### 3.2 认领（手机侧）

```
POST /pair/claim             Authorization: Bearer <mobileAuth>
{ code, deviceName, platform }
→ 200 { pairId, status: "pending_approval" }
```

校验顺序（任一失败即拒，且计入限速）：

| 条件 | 错误 |
|---|---|
| code 不存在 / 已过期 | `404 code_not_found` |
| code 已被其他手机 claim | `409 already_claimed` |
| device 已有 active pair 且未确认顶替 | `409 device_busy` |
| 同 mobileAuth 重复 claim 同一 code | `200`（幂等，返同 pairId） |
| 超限速 | `429 rate_limited` |

**`409 already_claimed` 是硬拒绝，不提供覆盖路径。** 同时向 PC 与该 pair 推 `pair/contested` 审计事件——抢码本身就是入侵信号。

### 3.3 批准 / 拒绝（PC 侧，唯一授权动作）

```
POST /pair/approve           Authorization: Device <deviceToken>
{ pairId, decision: "approve" | "reject" }
→ 200 { status, pairTokenForMobilePushed: true }
```

- 云拿到 approve 后签发 pairToken，经 SSE/WSS 分发给手机，PC 侧把 pairId 写入白名单。
- 若该 device 已有 active pair，`approve` 携带 `takeover: true` 时先 revoke 旧的（见 §4）。

### 3.4 撤销（任一方）

```
POST /pair/revoke            Authorization: Bearer <mobileAuth> | Device <deviceToken>
{ pairId, reason }
→ 200
```

单方面生效，无需对方同意（fail-safe）。

### 3.5 查询

```
GET /pair/current            → { pairId, status, mobile:{deviceName,lastSeen}, device:{...} }
```

## 4. 唯一性规则（**单向**，注意方向）

唯一性约束只作用在 PC 一侧，两个方向不对称：

| 方向 | 约束 | 含义 |
|---|---|---|
| **PC 侧** | 1 device → **1** active pair | 一台机器同一时刻只有一个 driver（无 observer） |
| **手机侧** | 1 user → **N** active pairs | 一个人可以控制多台机器（家里 / 公司 / 服务器），各自独立授权、独立撤销 |

手机侧多设备是产品必需，且不降低安全性：每台 PC 都要走一遍独立的 approve，撤销也互不影响。代价是手机端需要「设备列表 + 切换设备」UI，并分别展示各设备的 `active/suspended/revoked` 状态。

- **不做 observer**。第二台设备不存在只读通道。
- device 已有 `active` pair 时，新 claim 返回 `409 device_busy`，PC 页面提示：
  「当前由 iPhone 15 控制，继续配对将断开它」→ 人确认后 approve 带 `takeover: true`。
- 默认推荐 **takeover 路径**（换手机比手动解绑常见），但必须显式确认，不静默并存。

> ⚠️ 待确认项：takeover 是否允许？若不允许，则必须先手动 revoke 才能配新设备（更严，但换手机时多一步）。

## 5. 限速与 TTL

| 项 | 值 |
|---|---|
| code TTL | 120s |
| code 长度 | 6 位 Crockford Base32（≈ 30 bit） |
| claim 失败限速 | 每 IP 10 次/分钟；每 code 5 次后作废 |
| request 频率 | 每 device 6 次/分钟 |
| pairToken 有效期 | 12h，滑动续期需心跳 |
| deviceToken | 长期，落盘 `~/.pi/bridge/credentials.json`（0600） |

## 6. 审计事件（云端持久化）

`pair.requested` / `pair.claimed` / `pair.approved` / `pair.rejected` / `pair.revoked` / `pair.contested` / `pair.takeover` / `pair.suspended`

每条含 `pairId, deviceId, userId, ip, ua, ts`。`contested` 与 `takeover` 应额外告警。

## 7. 凭据生命周期与重新配对

```
配对码(120s, 一次性)
   └─ claim + approve ─┬─> deviceToken   （PC 侧，长期，~/.pi/bridge/credentials.json，0600）
                       └─> refreshToken  （手机侧，长期，IndexedDB/Keychain）
                              └─ 每次打开页面 ─> pairToken（12h，滑动续期，需心跳）
```

**日常几乎不需要重新配对。** 何时需要：

| 场景 | 要重配 |
|---|---|
| 开新任务 / 新会话 / 切 workspace | ❌ |
| 手机网络切换、bridge 重启、合盖唤醒 | ❌ 静默重连（`suspended` 宽限期内） |
| pairToken 过期 | ❌ 静默 refresh |
| bridge 升级/重装（凭据保留） | ❌ |
| 配对码 120s 过期 | ❌ 重新生成码即可，不属于重新配对 |
| 手机关机 / 清缓存 / 换手机 | ✅ |
| 手动 revoke | ✅（终态） |
| bridge 换机器（deviceId 变） | ✅ |
| 长期离线（默认 >30 天，可配） | ✅ |

## 8. 安全边界（明确不做的事）

- 云端**不提供**「远程批准」API——没有 approve 的 HTTP 端点供手机或管理后台调用。
- 配对码**不承载**任何权限，仅用于 claim。
- 不做 E2E 加密：云端需解析事件以支持持久化、快照、大产物索引（已确认允许存储内容）。
