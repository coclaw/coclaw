---
'@coclaw/openclaw-coclaw': patch
---

Fix: `__handleGatewayRequestFromDc` 在转发到 gateway 之前校验 `id` 与 `method` 必须是非空字符串。原先恶意或错配的 peer 发送 `{ "type": "req", "params": {...} }` 等残缺帧时，bridge 会以 `id: undefined / method: undefined` 转发给 gateway，污染 RPC 协议。现在缺字段时 drop + warn；有合法 `id` 但缺 `method` 时回 `INVALID_REQUEST` 帧让 peer 尽快放弃等待。
