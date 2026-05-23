---
'@coclaw/ui': patch
---

fix(ui): guard AddClawPage against double-click and SSE-stall stuck states

Two long-standing pitfalls on the "Add Claw" page are addressed:

1. **`startBinding` inflight guard**: rapid taps on the retry/restart
   button could fire `createBindingCode` twice, with the later response
   overwriting `bindingCode`. The first code became an orphan that lived
   on the server until natural expiry. The function now bails early if
   `this.loading` is already true, and the error-state "retry" button
   gains `:loading="loading"` so the UButton auto-disables during work.

2. **`captureBaseline` 15s timeout fallback**: when the global SSE
   pipe never delivers a first claw snapshot (`store.fetched` stays
   false), the page used to hang on the "Preparing..." spinner
   indefinitely. After 15s the page now falls back to a one-shot
   `listClaws()` REST call to seed `baselineClawIds`, letting the user
   continue through the CLI binding flow. If REST also fails, an empty
   baseline is used so the binding code at least appears.
