---
'@coclaw/openclaw-coclaw': patch
---

Drop `peerDependencies.openclaw` and `peerDependenciesMeta.openclaw.optional`
from `package.json`. On pnpm v10 with `auto-install-peers` enabled (the
default), the `optional: true` marker was not honored in this monorepo setup
and pnpm pulled the entire `openclaw` package plus its transitive dependency
graph into `pnpm-lock.yaml` (~2700 line bloat). The OpenClaw plugin loader's
literal-import alias mechanism resolves `openclaw/plugin-sdk/*` independently
of any plugin-local `node_modules/openclaw` symlink, so the loader's reassert
step (gated on the peer declaration) is not required for runtime resolution.

Verified end-to-end on both install paths:
- `--link` (plugin-dir): stage has no `openclaw` symlink, RPC calls succeed
- `plugin-archive` (`npm pack` + install): installed `node_modules/` has no
  `openclaw` symlink, RPC calls succeed

If SDK import ever fails at runtime, the chain of defenses is intact: no
top-level `openclaw` import exists in plugin source; the literal dynamic
imports live in arrow-function factories; first-call resolution is wrapped in
a `try/catch` that returns a structured `IO_FAILED` error; and the upstream
loader catches plugin load/register failures. The gateway main process is
never at risk.
