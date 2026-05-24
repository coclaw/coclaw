---
'@coclaw/ui': patch
---

fix(ui): guard AddClawPage against double-click orphan binding codes

Rapid taps on the retry/restart button on the "Add Claw" page could
fire `createBindingCode` twice, with the later response overwriting
`bindingCode`. The first code became an orphan that lived on the
server until natural expiry. `startBinding` now bails early if
`this.loading` is already true, and the error-state "retry" button
gains `:loading="loading"` so the UButton auto-disables during work.

The earlier 15s REST fallback for SSE stalls is dropped: claws data
is sourced exclusively from the global SSE snapshot pipe, and the
sole REST `listClaws()` caller was this fallback. Falling back to
REST here also introduced a new orphan-code path on quick unmount.
Better UX for "SSE never connects" will be designed separately.
