---
'@coclaw/ui': patch
---

fix(ui): notify on accepted-then-failed agent run

When the configured OpenClaw model is unavailable (e.g. `FailoverError`), the upstream `agent` RPC is accepted then fails with `ok=false + payload.status='error'`. The UI was treating "accepted" as success and dropping the error message, leaving the user with a silent failure (no toast, no input restore).

Pipe the original error all the way to a user-facing toast:

- `agent-runs.store.js` — surface `__endError` for the failed run; `__onRpcDone` recognizes business-level `status='error'` (and `'timeout'` when not cancelled) so a stray `ok=true + status='error'` won't be silently swallowed; `__onRpcFailed` ends a cancelled run with `'rpc'` (not `'failed'`) so user-cancel + transport reject doesn't fire a false-positive error toast.
- `chat.store.js` — `sendMessage` now returns `{ accepted, endReason, errorMessage }`; `sendSlashCommand` rejects immediately on `status='error' || 'timeout'` instead of waiting up to 24h for the slash timeout.
- `ChatPage.vue` — when `endReason ∈ {'failed','rpc-timeout'}` show a toast with the original first-line error truncated to 200 chars.
- i18n × 12 — adds `chat.errRunFailed`.
- A new `endReason='rpc-timeout'` keeps the 24h memory-fallback `'timeout'` distinct from upstream business-level timeout.
