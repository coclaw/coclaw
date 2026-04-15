---
"@coclaw/server": patch
"@coclaw/ui": patch
---

server/ui: `coclaw.info.updated` 改为 patch 语义，修复改名时清空 pluginVersion/agentModels

**问题**：plugin 的 `coclaw.info.patch` handler 仅广播 `{ name, hostName }`（按其 patch 命名所暗示）；但 server `applyClawInfoUpdate` 此前按"missing-as-null"当全量处理，导致用户每次从 UI 改名 → DB 清空 pluginVersion + agentModels → admin 仪表盘该 claw 行立即显示 "—" / "信息暂不可用"，直到 bridge 重连才恢复。

**修复**（方向：按事件命名的 patch 语义，修 server 而不是让 plugin 被迫发全量）：

- `server/src/claw-ws-hub.js` `applyClawInfoUpdate`：用 `Object.hasOwn(payload, key)` 逐字段判定，仅更新 payload 中实际出现的列；缺失字段保留 DB 原值。name 列的 hostName 回退仅当 payload 同时含 hostName 时应用（与 plugin 两个触发源的实际形态吻合）。
- `server/src/claw-status-sse.js` `handleInfoUpdatedEvent`：patch 不含 name 字段时直接返回，不下发冗余的 user-facing `claw.nameUpdated`/`bot.nameUpdated` 事件。
- `server/src/admin-sse.js` `handleInfoUpdatedEvent`：按 payload 实际含有的字段透传，wire 不再携带未变更字段。
- `ui/src/services/admin-stream.js`：去掉 `?? null` 的字段补齐，保留 patch 中字段的存在/缺失语义，交由 `admin.store.updateClawInfo` 的 "skip undefined" 逻辑只覆盖本次实际变更字段。
- `ui/src/views/AdminClawsPage.vue`：onInfoUpdated 回调从解构重组改为 `({ clawId, ...patch })`，避免 undefined 字段污染 patch。

不向 plugin 施加"必须发全量"的约束；`__pushInstanceInfo()`（bridge connect 时的全量上报）和 `coclaw.info.patch` handler（仅发变更字段）两种形态在 patch 语义下都正确工作。
