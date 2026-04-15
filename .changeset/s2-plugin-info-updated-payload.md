---
"@coclaw/openclaw-coclaw": minor
---

plugin: 扩展 coclaw.info.updated payload

- `__pushInstanceName` 改名为 `__pushInstanceInfo`
- 事件 payload 新增 `pluginVersion`（从 `plugin-version.js` 获取）和 `agentModels`（agent × 有效主模型，通过 `agents.list` RPC 采集）
- 新增 `__collectAgentModels` 方法；采集失败时 `agentModels` 为 null，不影响其它字段上报
