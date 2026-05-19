---
'@coclaw/openclaw-coclaw': patch
---

Drop the `sessions.changed phase=message` fallback for cron-driven session
eviction tracking. The `cron_changed` hook (available since OpenClaw v2026.4.29)
already covers the cron eviction case directly, and the phase=message path was
triggering a chat-history file reload on every transcript append across all
sessions — far broader than the cron-only scope it was meant to address.

The `sessions.changed` filter is back to `reason==='create'` only. The other
three reconciliation paths from the original stop-bleed change remain:
`cron_changed` hook (primary), startup reconciliation (`reconcileAll` covering
the gateway-restart window), and `__persist` sanitize (self-healing existing
dirty entries on every write).

Trade-off: user-initiated `sessions.compact` / `compaction.branch` /
`compaction.restore` RPCs from the OpenClaw UI no longer roll the chat-history
head sid until the next message append on that chat. The UI tolerates this via
its existing tail-anomaly guard.
