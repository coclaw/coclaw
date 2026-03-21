# ADR: 孤儿 Bot 记录防治

> 状态：已部分实施
> 日期：2026-03-21
> 触发：内测用户反馈 UI 中出现已解绑但仍显示的离线 Claw

## 背景

用户在 claw 侧执行 `openclaw coclaw unbind` 后，UI 仍显示一个离线的 Claw。排查发现该离线 Claw 并非刚解绑的 bot（那个已被正确删除），而是更早的一次绑定遗留的孤儿记录——其 token 已从 claw 本地丢失，无法通过常规途径清理。

**孤儿 bot** 定义：数据库中存在 bot 记录，但没有任何 claw 持有其 token，导致该 bot 永远离线且无法被 claw 侧解绑。

## 孤儿产生路径分析

### 路径 1（最常见）：重绑时 auto-unbind 静默失败 ✅ 已修复

**修复方案**：auto-unbind 从 best-effort 改为强制。unbind 失败时中止 bind（抛出 `UNBIND_FAILED`）。服务端返回 401/404/410 视为 bot 已不存在，允许继续。

### 路径 2：`waitForClaimAndSave` 失败/中断（待处理）

enroll 流程中，`claimBot`（服务端）创建新 bot 并删除 claim code 后，`waitForClaimAndSave` 以 fire-and-forget 方式运行。如果在 `writeConfig` 之前 gateway 重启、网络断开或 abort 信号触发，新 bot 的 token 永远不会写入 `bindings.json` → 即时孤儿。

### 路径 3：连续 enroll 的竞态（待处理）

用户快速发起两次 enroll 时，第一次的 `waitForClaimAndSave` 被 abort。如果服务端已完成 claim（bot 已创建），abort 会阻止 config 写入 → 孤儿。

### 路径 4 & 5：服务端无去重防护（待讨论）

服务端的 `bindBot` 和 `claimBot` 都是无条件 `createBot`，不检查该用户是否已有 bot。防线完全依赖插件侧的 unbind。

### 路径 6：`config.js` 非原子写入 ✅ 已修复

**修复方案**：`writeJson` 改用 `atomicWriteJsonFile`，read-modify-write 用 `createMutex` 保护。

### 路径 7：`bot.unbound` 消息与新绑定竞态 ✅ 已修复

**修复方案**：`__clearTokenLocal(unboundBotId)` 增加 botId 校验，只清除匹配的 bot config。

## 已否决的方案

### ❌ 服务端在创建 bot 时自动清理同用户的离线 bot

否决原因：服务端**无法区分**"暂时离线的合法 bot"和"永久失联的孤儿 bot"。在线状态是瞬时的，绑定关系是持久的。此方案会误杀以下合法场景：

- Claw 临时离线（关机、网络断开、gateway 重启）
- 多 Claw 用户的非活跃 Claw
- enroll 完成瞬间，bridge 尚未连上，新 bot 本身就是"不在线"状态

误删合法 bot 比孤儿 bot 问题严重得多。

## 已实施的修复（2026-03-21）

### 1. 强制 unbind（路径 1 根因修复）

- `bindBot` 中 auto-unbind 从 best-effort 改为强制
- unbind 失败时抛出 `UNBIND_FAILED`，中止 bind 操作
- 服务端返回 401/404/410 视为 bot 已不存在（`isAlreadyUnbound`），允许继续
- 网络错误或 5xx 视为无法确认删除，中止操作
- `unbindBot` 同理：server 不可达时抛出错误，不清理本地 config

### 2. bind/unbind CLI 瘦化为 gateway RPC（路径 1 配套）

- `openclaw coclaw bind/unbind` 改为通过 `callGatewayMethod('coclaw.bind/coclaw.unbind')` 走 gateway RPC
- 与 `enroll` CLI 统一架构：CLI 仅做参数解析 + RPC 调用 + 结果展示
- gateway 内部 `doBind`/`doUnbind` 函数统一处理 bridge 管理（stop → unbind → bind → start）
- 斜杠命令 handler 共享同一内部函数
- 所有 `bindings.json` 操作收敛到 gateway 进程内，消除跨进程竞态

### 3. `config.js` 原子写入 + mutex（路径 6 修复）

- `writeJson` 改用 `atomicWriteJsonFile`（tmp + rename 原子操作）
- `writeConfig` 和 `clearConfig` 用 `createMutex` 保护 read-modify-write

### 4. `__clearTokenLocal` botId 校验（路径 7 修复）

- `__clearTokenLocal(unboundBotId)` 增加 botId 参数
- 当 `unboundBotId` 与当前 config 的 `botId` 不匹配时跳过清除
- 无 botId 参数时保持原有行为（兼容）

## 待处理

### enroll 流程的 `waitForClaimAndSave`（路径 2/3）

如果 server 端已完成 claim 但 `waitForClaimAndSave` 被 abort 或 crash，仍会产生孤儿。概率较低（需要恰好在 claim 成功和 config 写入之间中断），可后续单独处理。

### 服务端辅助手段（路径 4/5）

- 在 `GET /api/v1/bots` 响应中标注 `lastSeenAt`，帮助用户识别长期离线的 bot
- 提供"清理离线 bot"的用户操作入口（需用户确认）
- 具体方案待定
