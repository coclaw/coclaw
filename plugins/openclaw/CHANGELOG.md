# @coclaw/openclaw-coclaw

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
