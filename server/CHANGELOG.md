# @coclaw/server

## 0.15.0

### Minor Changes

- 683ba36: Add `POST /api/v1/log/ui` HTTP endpoint to receive UI remote diagnostic logs over an independent short-connection channel (separate from the RTC signaling WS). The endpoint accepts a batch `{ uiId, seq, logs[] }` with up to 100 entries and a 1 MB body, performs monotone-seq deduplication per `uiId` in an in-memory map (entries pruned after 1 h of inactivity by a 5 min sweep), and prints each entry as `[remote][ui][user:<id>|anon][batch=<uiId 尾部 8>:<seq>][ts=<ISO_UTC>] <text>`. Schema validation rejects malformed payloads with 400 without touching the dedup map; non-POST methods return 405 before any body parsing. The endpoint is not authenticated — session cookie, when present, is used only for identity labeling. The RTC signaling WS `type:'log'` branch is left intact as a 4-week rollback safety net.

### Patch Changes

- 2a71f14: Render the per-entry timestamp on incoming remote-log (`type: 'log'`) packets as a `[ts=<ISO_UTC>]` field instead of the previous local-timezone `HH:mm:ss.SSS` rendering. The field is glued directly to the trailing `]` of the prefix block and separated from the message body by a single space, so the new shape is `[remote][plugin][claw:<id>][ts=2026-05-12T08:26:16.450Z] <text>` (the previous `|` separator is gone). Missing/invalid `ts` falls back to `[ts=??]` instead of `??:??:??.???`. Affects both `claw-ws-hub.js` (plugin path) and `rtc-signal-hub.js` (UI path). Plugin/UI clients are untouched — they still send the same `{ ts: number, text: string }` shape; only the server-side rendering changes. Rationale: docker `-t` (server receive ts) and the in-line client-emit ts are now both UTC and easy to extract with `\[ts=([0-9-]+T[0-9:.]+Z)\]`, so agents can sort cross-end log streams by event time in dictionary order without any timezone juggling.

## 0.14.0

### Minor Changes

- 9b9e84e: feat(server): support hiding a Web Agent from the user's recent list

  Adds the backend half of the "remove from recent" action on MainList Web Agents. New nullable `hiddenAt` column on `WebAgentClick` (NULL = not hidden), exposed on the existing `GET /api/v1/web-agents` payload. New endpoint `POST /api/v1/web-agents/:id/hide` flips `hiddenAt` to now via `updateMany` (no-op + 404 when the user has never clicked the agent, so a hide for a never-clicked entry will not silently materialise a click row). The existing `POST /:id/click` upsert now also clears `hiddenAt` on the update branch, so re-clicking an agent automatically un-hides it without a separate request. Repeat hides are idempotent. Existing `WebAgentClick` rows are unaffected by the migration (column is nullable with no default backfill).

## 0.13.0

### Minor Changes

- 606916e: feat(server): add Web Agent feature backend (schema, presets, repo/service/route, startup hook)

  Introduces the backend side of the public-AI Web Agent entry point. New `WebAgent` and `WebAgentClick` Prisma models (with `User` reverse fields), a code-driven preset list (`web-agent.presets.js`), and a bidirectional `syncPresets` that runs before `app.listen` to keep the DB and the preset list aligned (preset removed from code → row deleted → click history cascaded). Adds `GET /api/v1/web-agents` (returns presets + the user's lastClickedAt) and `POST /api/v1/web-agents/:id/click` (per-user upsert of click count and lastClickedAt). The `:id` parameter is validated as a positive integer within the `UnsignedInt` range (1..4294967295). UI/MainList integration follows in subsequent commits.

## 0.12.2

### Patch Changes

- ce546d3: fix(plugin): keep WebRTC sessions across server WS reconnect; tighten heartbeat miss limit to 3

  Plugin side:

  - Decouple PeerConnection lifecycle from server WS lifecycle. On non-auth WS close (heartbeat timeout 4000, abnormal 1006, etc.), the bridge now retains `webrtcPeer` and `fileHandler` instances so existing UI <-> plugin data channels survive a WS reconnect. Auth-close (4001/4003) still tears down PCs and clears the local token. `stop()` continues to close all PCs deliberately.
  - Tighten `SERVER_HB_MAX_MISS` from 4 to 3 so detection lands at ~135s instead of ~180s. Real-world worst observed main-thread spike (~89.5s, OpenClaw upstream issue #75069) still has ~1.5x margin.
  - `__forwardToServer` now logs a warning instead of silently dropping when WS is not ready or `send` throws, so signaling drops during a WS-down window become visible. Full queue/rollback behavior is tracked in plugins/openclaw/TODO.md.

  Server side:

  - Mirror the `CLAW_PING_MAX_MISS` heartbeat limit from 4 to 3 to keep both directions of the plugin <-> server WS in sync.

## 0.12.1

### Patch Changes

- fix(rtc): take over orphaned signaling WS on client reconnect

  When a UI instance switches networks (e.g. WiFi↔cellular), it closes its old
  signaling WS and opens a new one, reusing the original connId to preserve ICE
  restart semantics on the plugin side. The server previously refused any
  `rtc:offer` on the new WS with `connId=... occupied by another WS`, because the
  orphaned half-open WS still held the connId in the routing table. Every ICE
  restart attempt (6 × ~15 s) failed, forcing UI to fall back to a full PC rebuild.

  **Root cause**: `register()` in `rtc-signal-router.js` rejected on `existing.ws
!== ws`, and there is no server-side heartbeat on the signaling WS today — so a
  half-open WS lingers until the kernel's TCP keepalive kicks in (hours).

  **Fix**: Upgrade `register()` to interpret a connId collision (new ws + same
  userId + same clawId) as "the same UI instance has migrated to a new WS." When
  triggered, it atomically rewrites every connId on the old WS to point at the
  new WS, then `terminate()`s the old WS. This matches the intent of
  `claw-ws-hub.js`'s existing stale-socket cleanup on the plugin side. The
  `rtc:ice` / `rtc:ready` paths get the same takeover when `route.ws !== ws`, so
  the fix is symmetric regardless of which signaling frame arrives first after
  reconnect.

  **Safety**:

  - `existing.userId !== userId` still rejects. connId is a UUID v4 generated
    by the UI, so a collision across users can only happen as a cross-user
    forgery attempt; `userId` is the true safety boundary.
  - `removeByWs()` now guards each deletion with `entry.ws === ws` to prevent the
    old WS's delayed `close` event from wiping routes that the new WS already
    took over. The `rtc:closed` handler applies the same guard before removing.
  - `register()` return type changes from `boolean` to `{ok, migrated}` so the
    hub can emit a `signal ws takeover` info log on the rare takeover path.

  Out of scope: server-side heartbeat for the signaling WS (separate follow-up).

## 0.12.0

### Minor Changes

- a1e1b64: admin Dashboard 在线实例数实时化 —— SSE 作为在线状态的唯一事实源，消除 Dashboard 页与 Claws 列表页之间的不一致。

  - **server（API 响应结构调整）**：`GET /api/v1/admin/dashboard` 响应移除两个字段：`claws.online`（聚合在线数）与 `latestBoundClaws[].online`（每条布尔）。在线状态改由 `GET /api/v1/admin/stream`（已具备 `requireAdmin` 校验）独立提供。`/api/v1/admin/claws` 列表的 online 字段保留以作为 HTTP 首屏填充。旧版 UI 客户端访问新 server 时，Dashboard 在线数大卡片会显示空白而非数字，但不会崩溃。
  - **ui**：SSE 订阅从页面组件上移到 Pinia `admin` store（引用计数），新增 `onlineClawIds: Set<string>`、`hasOnlineSnapshot`、`onlineClawCount`、`isClawOnline(id)`；连接生命周期由新建的 `AdminLayout` 父路由薄壳在 `/admin/*` 挂载/卸载时自动启停。Dashboard 大卡片在 SSE snapshot 到达前显示 `—` 占位符，snapshot 到达后切换为实时数字；Top 10 绿点改读 store 派生值。AdminClawsPage 不再直接订阅 SSE。
  - **ui（权限守卫加固）**：路由 `beforeEach` 新增 `requiresAdmin` meta 校验，非 admin 用户访问 `/admin/*` 直接重定向到 `/home`，避免 AdminLayout 挂载后对 `/admin/stream` 发起无授权的 EventSource 握手。
  - **ui（SSE 握手熔断）**：`admin-stream.js` 在从未 `onopen` 成功的情况下连续 3 次 `onerror` 则停止重连，避免非授权环境下的死循环。握手成功后错误不计入熔断计数。
  - 保活机制不变（server 30s heartbeat / client 65s timeout）。

- 6ade9f0: admin dashboard 新增「已发布的插件最新版本」展示。

  server 启动后每小时并行查询 npm 官方源与阿里镜像（`@coclaw/openclaw-coclaw/latest`），两源版本不同时取镜像、单源失败另一源兜底、全部失败保留上一次缓存。admin dashboard 接口的 `version.plugin` 字段从原来读取本地 `plugins/openclaw/package.json`（部署容器中无此目录，永远为 `null`）改为返回 server 缓存的最新发布版本号，ui-admin 页面无需改动即可显示实际版本。

### Patch Changes

- 844fa04: 修复 plugin-latest 查询在 shell 存在 `HTTPS_PROXY` 时报 HTTP 400。

  axios 1.x 遇到 env 里的 HTTPS_PROXY 会自动走代理，但其代理实现对公网 registry 的 CONNECT 处理常与本地代理中间件不兼容（curl 可 200，axios 报 400 / socket hangup）。此处固定 `proxy: false`：本服务只请求公网 npm/阿里镜像，部署环境一般直连，本地开发也无需代理走 npm。

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
