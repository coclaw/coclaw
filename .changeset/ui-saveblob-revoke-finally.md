---
'@coclaw/ui': patch
---

fix(ui): guarantee revokeObjectURL on Web saveBlobToFile error paths

`saveBlobToFile` on the Web branch did `createObjectURL → appendChild →
click → removeChild → revokeObjectURL` as a straight-line sequence. If
any step in the middle threw (especially `a.click()`), the function
exited without revoking the ObjectURL — the URL stayed reachable until
the browser tab closed.

Wrap the DOM operations in nested try/finally so `revokeObjectURL` (and
`removeChild`) run on the unwind path. DOM step exceptions are still
re-thrown so callers see the failure.
