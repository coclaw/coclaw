# @coclaw/server

## 0.11.0

### Minor Changes

- 8a3d45f: server: Claw 表新增 hostName/pluginVersion/agentModels 三字段

  - Prisma schema 新增字段 + 配套 migration（纯 ADD COLUMN nullable，零停机）
  - `claw-ws-hub.js` 扩展 `coclaw.info.updated` 处理：持久化全部字段（Json? 用 `Prisma.DbNull` 显式写 SQL NULL），`name` 列在 plugin 未设名时用 hostName 回退以兼容现有 user-facing UI
  - 真正 offline 分支（管理性断连立即 / 普通断连 grace 超时后）新增 `markClawLastSeen` 写入
  - `clawStatusEmitter` 事件名 `nameUpdated` → `infoUpdated`；claw-status-sse 同步监听，handler 对用户侧 SSE 仍只下发 `{ clawId, name }`

- 3b69100: server: admin dashboard 改造 + 实例/用户列表 + admin SSE

  - `admin.repo.js` 新增 `countClawsCreatedSince` / `latestBoundClaws` / `listClawsPaginated` / `listUsersPaginated`（cursor 分页 + search）
  - `admin-dashboard.svc.js` 改造返回结构：`claws` 新增 `todayNew`、新增 `latestBoundClaws`（在线标记）、`topActive/latestRegistered` 各 10 条、移除遗留 `bots` 别名
  - `admin.route.js` 新增 `GET /admin/claws` / `/admin/users` / `/admin/stream`（均 `requireAdmin` 守门）
  - 新增 `admin-sse.js`：admin 全局 SSE，转发 `clawStatusEmitter` 的 `status` / `infoUpdated` 为 `claw.statusChanged` / `claw.infoUpdated`

### Patch Changes

- c91a917: server/ui: `coclaw.info.updated` 改为 patch 语义，修复改名时清空 pluginVersion/agentModels

  **问题**：plugin 的 `coclaw.info.patch` handler 仅广播 `{ name, hostName }`（按其 patch 命名所暗示）；但 server `applyClawInfoUpdate` 此前按"missing-as-null"当全量处理，导致用户每次从 UI 改名 → DB 清空 pluginVersion + agentModels → admin 仪表盘该 claw 行立即显示 "—" / "信息暂不可用"，直到 bridge 重连才恢复。

  **修复**（方向：按事件命名的 patch 语义，修 server 而不是让 plugin 被迫发全量）：

  - `server/src/claw-ws-hub.js` `applyClawInfoUpdate`：用 `Object.hasOwn(payload, key)` 逐字段判定，仅更新 payload 中实际出现的列；缺失字段保留 DB 原值。name 列的 hostName 回退仅当 payload 同时含 hostName 时应用（与 plugin 两个触发源的实际形态吻合）。
  - `server/src/claw-status-sse.js` `handleInfoUpdatedEvent`：patch 不含 name 字段时直接返回，不下发冗余的 user-facing `claw.nameUpdated`/`bot.nameUpdated` 事件。
  - `server/src/admin-sse.js` `handleInfoUpdatedEvent`：按 payload 实际含有的字段透传，wire 不再携带未变更字段。
  - `ui/src/services/admin-stream.js`：去掉 `?? null` 的字段补齐，保留 patch 中字段的存在/缺失语义，交由 `admin.store.updateClawInfo` 的 "skip undefined" 逻辑只覆盖本次实际变更字段。
  - `ui/src/views/AdminClawsPage.vue`：onInfoUpdated 回调从解构重组改为 `({ clawId, ...patch })`，避免 undefined 字段污染 patch。

  不向 plugin 施加"必须发全量"的约束；`__pushInstanceInfo()`（bridge connect 时的全量上报）和 `coclaw.info.patch` handler（仅发变更字段）两种形态在 patch 语义下都正确工作。

- c91a917: server: 抽 claw ws close handler 的 offline 分支为可测函数

  新增 `finalizeClawOffline(clawId, deps?)` 和 `scheduleClawGraceOffline(clawId, deps?)` 两个具名导出，替换 `attachClawWsHub` 内联的 offline 处理逻辑。外部行为与前版一致（管理性 close code 4001/4003 立即 finalize；普通断连走 5s grace，期间重连不触发；grace 超时且未重连才真正 offline）。

  动机：原先内联 close handler 无集成测试保护，未来若有人误删 `markClawLastSeen(clawId)` 调用，CI 无法发现。抽函数后补了 5 个单测断言 markLastSeen 的调用时机与 offline 事件发射。

## 0.9.1

### Patch Changes

- 37aedde: fix(server): 精简 TURN URL 生成逻辑，移除不再需要的双域名兼容 URL；为 genTurnCredsForGateway 添加临时兼容性标注

## 0.7.1

### Patch Changes

- ui: add cloud deploy guide, debug build variant, reconnection optimization, remove per-bot inline loading
  server: simplify coverage config, raise test coverage to 90%+

## 0.6.0

### Minor Changes

- feat(server): add RTC signaling hub, remote log channel, and SSE bot snapshot

## 0.5.3

### Patch Changes

- feat: 管理员仪表盘新增最新注册用户列表；服务端新增插件版本号返回及 loginName 查询

## 0.5.1

### Patch Changes

- fix: TURN 端口可配置化，不再硬编码 3478

## 0.1.1

### Patch Changes

- 0cf6cec: fix(ui,server): add WS heartbeat and improve chat disconnect resilience

  - UI WS client: 25s ping / 45s timeout heartbeat to detect silent disconnections on mobile
  - Server: respond to application-level ping/pong + WS protocol-level ping for UI connections
  - ChatPage: 30s pre-acceptance timeout to prevent infinite "thinking" state
  - ChatPage: suppress duplicate error toasts when timeout/lifecycle:end already handled
  - ChatPage: lifecycle:end uses fresh WS connection for refresh; preserves user message on failure

- fix(server,ui): accumulated fixes since changeset adoption

  - server: extend binding code expiry from 5 to 30 minutes
  - server,ui: push bot name update via SSE after bridge connects
  - ui: update plugin id to openclaw-coclaw and improve AddBot page layout
  - ui: distinguish bot offline from unbound in ChatPage notification
  - ui: remove redundant bind-success notify and guard unbind double-click
  - plugin,ui: fix new-chat failure and missing session for agent:main:main
