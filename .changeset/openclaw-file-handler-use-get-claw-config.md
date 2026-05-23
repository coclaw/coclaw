---
'@coclaw/openclaw-coclaw': patch
---

refactor(plugin): route file-handler `resolveWorkspace` through `getClawConfig`

`resolveWorkspace` (the dependency injected into `createFileHandler`)
was the last in-repo call site still reaching into
`api.runtime?.config?.loadConfig()` directly. Every other config-reading
path already goes through `getClawConfig()`, which prefers the
v2026.4.27+ `config.current()` API and falls back to `loadConfig()` for
older hosts.

Switching this one call site closes the consistency gap and removes the
remaining trigger for OpenClaw's deprecation warning on every
`coclaw.files.*` RPC under newer hosts. No behavioral change on
supported hosts; existing tests stub `config.loadConfig`, which is the
fallback path inside `getClawConfig`, so the harness covers both new
and legacy APIs.
