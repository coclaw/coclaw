---
"@coclaw/server": minor
---

server: Claw 表新增 hostName/pluginVersion/agentModels 三字段

- Prisma schema 新增字段 + 配套 migration（纯 ADD COLUMN nullable，零停机）
- `claw-ws-hub.js` 扩展 `coclaw.info.updated` 处理：持久化全部字段（Json? 用 `Prisma.DbNull` 显式写 SQL NULL），`name` 列在 plugin 未设名时用 hostName 回退以兼容现有 user-facing UI
- 真正 offline 分支（管理性断连立即 / 普通断连 grace 超时后）新增 `markClawLastSeen` 写入
- `clawStatusEmitter` 事件名 `nameUpdated` → `infoUpdated`；claw-status-sse 同步监听，handler 对用户侧 SSE 仍只下发 `{ clawId, name }`
