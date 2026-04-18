---
'@coclaw/openclaw-coclaw': minor
'@coclaw/ui': minor
---

claws 页面中继连接展示两段链路协议（浏览器↔coturn↔plugin），避免仅显示浏览器侧协议导致的误导。

- Plugin（`@coclaw/openclaw-coclaw`）：pion 路径下新增 `coclaw.rtc.peerTransport` DC 事件单播。rpc DC 建立时和 ICE 选中 pair 变化时，把本端 candidate 的 `{ candidateType, protocol, relayProtocol }` 推送给对应 UI；签名去重避免重复发送，`queueMicrotask` 避让竞态，`sendTo` 失败回滚签名允许后续重试。顺手增强 `__logNominatedPair` 远程日志，带出 protocol 和 relayProtocol。werift 路径保持不变（其 candidate 对象无 relayProtocol，UI 自动走降级兜底）。
- UI（`@coclaw/ui`）：`claws.store` 监听新事件更新 `claw.rtcPeerTransportInfo`（与 `rtcTransportInfo` 字段解耦，避免被浏览器 getStats 轮询整体覆盖）；`failed/closed` 时清空。`ManageClawsPage.connLabel` 在 relay 分支合并双端信息：两端协议相同时简化为 `中继·UDP`，不同时展示 `UDP ↔ 中继 ↔ TCP`；详情面板新增"对端候选/对端中继协议"一行。新增 i18n keys `rtcRelayBothSides` / `peerCandidate` / `peerRelayProtocol`，12 语言全同步。
- 兼容性：依赖 `@coclaw/pion-node` 0.1.3+（新增 `relayProtocol` 字段透传）。老 plugin / 老 pion-ipc 二进制下事件不发，UI 自动回退老文案，不报错。
