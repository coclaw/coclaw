# @coclaw/openclaw-coclaw

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
