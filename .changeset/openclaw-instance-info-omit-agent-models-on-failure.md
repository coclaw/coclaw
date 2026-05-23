---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin/realtime-bridge): omit `agentModels` (instead of sending null) when collection fails; raise `agents.list` timeout to 30s

`__pushInstanceInfo` broadcasts the plugin's instance info to server and
UI via `coclaw.info.updated`, which is processed under **patch
semantics**: a field appearing in the payload (even with explicit
`null`) overwrites the stored value; a missing field leaves the prior
value untouched.

When `__collectAgentModels` returned `null` (timeout / RPC failure /
unexpected throw), `__pushInstanceInfo` previously placed
`agentModels: null` in the payload, which the server happily applied —
clearing the admin dashboard's per-plugin agent list until the next
successful push. The OpenClaw manifest-cache mismatch issue (#80697)
makes `agents.list` flake to ~10s under load, which the prior 3s
timeout could not absorb, so the dashboard would sporadically blank
out on reconnect.

Two changes:

- `__pushInstanceInfo` now omits `agentModels` from the payload when
  collection fails, so patch semantics preserve the prior value.
- `__collectAgentModels` raises its `agents.list` RPC timeout from 3s
  to 30s, giving manifest-cache cold paths room to recover before
  surfacing a collection failure.

Callers of `__pushInstanceInfo` are all fire-and-forget (post-handshake
on the gateway WS, and re-push on outer-socket open when gateway is
already ready), and pending `__gatewayRpc` requests are keyed by
independent reqIds, so multiple in-flight pushes during a reconnect
storm do not collide. The schema in `docs/plugin-events.md` still
allows `agentModels: ... | null` for protocol compatibility; the doc
now notes that the plugin no longer emits the explicit-null form.
