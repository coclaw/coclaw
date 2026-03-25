# @coclaw/openclaw-coclaw

## 0.8.1

### Patch Changes

- fix(webrtc): correct ICE restart handling and fix session cleanup race

## 0.8.0

### Minor Changes

- feat: implement file management via WebRTC DataChannel (list/delete/read/write with path security, backpressure flow control, and temp file cleanup)

## 0.7.1

### Patch Changes

- fix: rename internal function to avoid OpenClaw install-time security scanner warning

## 0.6.2

### Patch Changes

- Delegate bind/unbind to gateway RPC, harden config I/O with atomic writes and mutex, improve error handling in realtime bridge

## 0.6.1

### Patch Changes

- e2528cc: coclaw.info RPC 新增 clawVersion 字段，返回 OpenClaw 版本号（当上游 resolveVersion() 可用时）

## 0.6.0

### Minor Changes

- Add claim-bind (enroll) flow for OpenClaw-initiated binding; align gateway method error response format with OpenClaw protocol; fix shell mangling JSON params in gateway RPC calls

## 0.5.2

### Patch Changes

- fix(bridge): 从环境变量 OPENCLAW_GATEWAY_PORT 自动检测 gateway 端口，不再硬编码 18789。修复非默认端口的 OpenClaw 实例绑定后所有 RPC 失败（"Gateway is offline"）的问题。

## 0.5.1

### Patch Changes

- fix(plugin): coclaw.info 等待 ensureAllAgentSessions 完成后再响应，修复新 OC 实例首次连接时空 session 导致无法进入对话页面的问题

## 0.5.0

### Minor Changes

- 新增 chat 历史追踪与统一消息加载能力：
  - ChatHistoryManager：通过 session_start 钩子追踪 chat reset 产生的孤儿 session，持久化到 coclaw-chat-history.json
  - coclaw.chatHistory.list RPC：供 UI 查询指定 chat 的孤儿 session 链
  - coclaw.sessions.getById RPC：按 sessionId 返回完整 JSONL 行级消息（type + id + message），替代 nativeui.sessions.get
  - coclaw.info capabilities 新增 chatHistory
  - 修复 recordArchived 竞态：在 mutex 内先从磁盘重载，防止 list() 无锁覆写缓存导致数据丢失

## 0.4.1

### Patch Changes

- 新增 coclaw.topics.update gateway 方法，支持通过 RPC 更新 topic 标题；修复 changes 不含有效字段时静默成功的问题

## 0.4.0

### Minor Changes

- feat(plugin): add Topic management support

  - New `src/topic-manager/` module with `TopicManager` class (in-memory model + `coclaw-topics.json` persistence per agentId, using mutex + atomicWriteJsonFile)
  - New `src/topic-manager/title-gen.js` for AI-powered title generation (copy `.jsonl` transcript, invoke agent via gateway WS two-phase RPC, clean title text, update topic metadata, cleanup temp files)
  - Extended `realtime-bridge.js` with `__gatewayAgentRpc` method supporting agent() two-phase response protocol (accepted -> final), exposed via singleton `gatewayAgentRpc()`
  - Registered 7 new gateway methods: `coclaw.info`, `coclaw.topics.create`, `coclaw.topics.list`, `coclaw.topics.get`, `coclaw.topics.getHistory`, `coclaw.topics.generateTitle`, `coclaw.topics.delete`
  - `coclaw.info` returns plugin version and capabilities list for UI version/feature checking
  - Topic data stored at `~/.openclaw/agents/<agentId>/sessions/coclaw-topics.json`, leveraging OpenClaw's per-agent sessions directory isolation

## 0.3.2

### Patch Changes

- fix: declare tool-events capability for gateway connection, enabling tool call streaming events

## 0.3.1

### Patch Changes

- fix: bind 后 OpenClaw 始终离线的回归问题（需重启 gateway 才能上线）

## 0.3.0

### Minor Changes

- feat: add multi-agent session ensure support for OpenClaw nativeui.sessions.ensure gateway method

## 0.2.4

### Patch Changes

- 4f89f91: fix(plugin): add device identity to gateway WS connection for OpenClaw 3.12+ scope enforcement

  OpenClaw 3.12 introduced a security fix (CVE GHSA-rqpp-rjj8-7wv8) that strips scopes from WS connections without device identity. This caused `nativeui.sessions.listAll` and `agent.identity.get` calls to fail with "missing scope" errors.

  - Add `src/device-identity.js`: Ed25519 key pair generation, storage (`~/.openclaw/coclaw/device-identity.json`), and v3 auth payload signing
  - Modify `realtime-bridge.js`: capture nonce from `connect.challenge`, build signed `device` field in connect params
  - Device identity is auto-generated on first connection and cached for subsequent reconnects
  - Backward compatible with OpenClaw >= 2026.2.19

## 0.2.3

### Patch Changes

- realtime-bridge 心跳超时改为连续 miss 计数策略（4 次 ~3 分钟），避免大消息传输期间误断连

## 0.2.1

### Patch Changes

- fix: auto-upgrade logger 兼容 gateway pino 风格，修复 "log is not a function" 导致升级流程中断的问题

## 0.1.7

### Patch Changes

- - fix: prevent bot.unbound race condition and fix bridge reconnect after rebind
  - feat: auto-rebind on bind and add request timeouts
  - fix: strip operator-configured policy prefix in derivedTitle
  - fix: enhance derivedTitle cleaning for cron time and untrusted context
  - refactor: architecture cleanup before auto-upgrade feature

## 0.1.6

### Patch Changes

- fix: unbind 时无论 server 通知是否成功，都清理本地绑定信息，避免用户陷入无法 unbind 也无法 bind 的死锁状态

## 0.1.5

### Patch Changes

- Fix server URL resolution: correct plugin entries key, default to im.coclaw.net, unbind and realtime-bridge use bindings.json as authoritative source

## 0.1.4

### Patch Changes

- fix(plugin): session get returns empty messages instead of throwing when transcript file missing

## 0.1.3

### Patch Changes

- fix(plugin): handle missing .jsonl for agent:main:main sessionKey and ensure it exists on startup

## 0.1.2

### Patch Changes

- fix(plugin): align plugin id with npm package name (openclaw-coclaw)
