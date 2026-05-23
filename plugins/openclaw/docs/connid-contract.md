# connId 字符集契约

> 范围：server ↔ plugin（webrtc-peer + rpc 队列） 之间共享。
> 状态：当前真相（PRE-EXISTING 契约，正式化）。

## 契约

`connId` 必须匹配 `^[A-Za-z0-9._-]+$`：

- 允许：大小写字母、数字、`.`、`_`、`-`。
- 禁止：`:` / `/` / 空白 / `+` 等其它任何字符。
- 至少 1 个字符；无显式最大长度（实际由 server 控制，目前 `c_<digits>` 形态约 10–20 字符）。

字符集与 `src/utils/memory-queue.js` / `src/utils/file-backed-queue.js` 构造函数里的 `ID_RE` 完全一致。

## 当前 server 形态

server 端给每条 WebRTC connection 分配的 connId 形如 `c_<digits>`，符合契约。

## 违反时会发生什么

`src/webrtc/webrtc-peer.js` 装配 rpc 队列时把 connId 直接 / 加唯一后缀拼进 queue `id`：

- **FBQ 模式**：`new FileBackedQueue({ id: ${connId}-${ts}-${nonce}, ... })`
- **MemoryQueue 模式**：`new MemoryQueue({ id: connId, ... })`

两个 queue 构造函数都用同一条 `ID_RE` 校验。**connId 含非法字符 → 构造抛 TypeError**：

1. 被 `__setupDataChannel` 外层 `try / catch` 兜底，仅记一条 warn 日志。
2. session 三件套（`rpcQueue` / `rpcDcSender` / `rpcChannel`）保持 null。
3. 该 connection 的 rpc DC 路径**残废**——任何 `sendTo(connId, ...)` 因 queue 为空而返回 false，server 端的两阶段 RPC 响应永远到不了 plugin。
4. 业务面表现：UI 该 conn 上发起的 RPC 全部超时；不影响其它 conn。

## 为什么用前缀+元字符的 `ID_RE` 而不是直接 sanitize

`utils/memory-queue.js` 与 `utils/file-backed-queue.js` 是通用工具，`ID_RE` 主要防"路径穿越"（FBQ 的 id 会拼进文件名）。在装配点 sanitize（如 `connId.replace(/[^A-Za-z0-9._-]/g, '_')`）会让 plugin 单方面接受 server 偷偷换格式，掩盖契约破坏。当前选择"显式 fail-loud"——server 改格式必须先和 plugin 对齐，不容静默兼容。

## 修复方向（若 server 将来必须引入特殊字符）

按优先级：

1. **保留契约**：让 server 维持 `^[A-Za-z0-9._-]+$`。最低成本。
2. **放宽契约**：在 `ID_RE` 里加新字符（如允许 `:`），同步更新本 doc + 两个 queue 工具 + 测试覆盖。
3. **装配层 sanitize**：仅当 1/2 都不可行时使用。需在装配点存一份 `connId → sanitizedId` 反查表，并接受跨 conn 撞 id 风险（sanitize 把不同 connId 映射到同一 sanitizedId）。

## 关联

- 装配点：`src/webrtc/webrtc-peer.js`（`__setupDataChannel` 内 queue 构造段）
- 校验源：`src/utils/memory-queue.js` 的 `ID_RE`、`src/utils/file-backed-queue.js` 的 `ID_RE`
- 历史出处：2026-05-05 B-stage2 B9b deep-review 抓出（原 `TODO.md` "connId 字符集隐式契约"条目）
