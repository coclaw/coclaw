---
'@coclaw/ui': patch
---

fix(ui): silence error toast when user cancels and upstream returns status='error'

`__onRpcDone` in `agent-runs.store.js` previously gated only `status='timeout'` on `!run.cancelled` but not `status='error'`. When a user cancelled an in-flight run and the upstream happened to return `status='error'` (e.g., plugin internal exception racing with cancel), the run was wrongly ended with `'failed'` and produced a false-positive error toast. Aligns the cancellation guard symmetrically across both error and timeout business statuses — both now silently end with `'rpc'` when cancelled.
