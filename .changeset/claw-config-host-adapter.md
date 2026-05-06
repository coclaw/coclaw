---
'@coclaw/openclaw-coclaw': patch
---

Centralize OpenClaw runtime config access behind a single host-adapter helper
(`getClawConfig` in `src/claw-config.js`) and prefer the new `config.current()`
API over the deprecated `config.loadConfig()`. OpenClaw v2026.4.27+ ships the
new accessor and emits a one-time `runtime-config-load-write` deprecation
warning the first time `loadConfig()` is called; both APIs return the same
`getRuntimeConfig()` snapshot, so the switch is purely about avoiding the
warning while staying
compatible with hosts ≤ v2026.4.26 (which only have `loadConfig`). Two
callsites — gateway auth-token resolution and the legacy install-record
fallback in auto-upgrade — now go through the helper instead of touching
`runtime.config` directly, so future host-API churn lands in one place.
