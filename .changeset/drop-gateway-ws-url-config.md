---
"@coclaw/openclaw-coclaw": patch
---

Drop unused `pluginConfig.gatewayWsUrl` fallback. Plugin and gateway always share a host/port resolved from `OPENCLAW_GATEWAY_PORT`, and the `COCLAW_GATEWAY_WS_URL` env override remains for dev/debug. Also removes the field from the plugin config schema; any leftover entry under `plugins.entries.<id>.config.gatewayWsUrl` should be cleaned up since `additionalProperties: false` will reject it.
