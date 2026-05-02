---
'@coclaw/ui': minor
---

Cancel coordination now passes `runDuration` / `abortDuration` (ms) in `coclaw.agent.abort` RPC params, enabling plugin-side heuristic cancel resolution. Adds the new terminal reason `gone` and changes how an existing reason is handled:
- `gone` (new) — plugin heuristically determined the run has ended; UI proactively settles the local run via new `agentRunsStore.settleByCancel` action and shows an info toast.
- `not-supported` (existing reason, behavior changed) — UI now also proactively settles the local run (previously only stopped the tick loop), letting the user resume sending immediately.

Both toasts (info for `gone`, warning for `not-supported`) are triggered from the store via `getSharedNotifier`, so the handoff path (pre-accept STOP → onAccepted internal cancelSend) also gets feedback.

Backward compatible with older plugins that ignore the new fields and keep returning `not-found` (UI continues retry until natural end).
