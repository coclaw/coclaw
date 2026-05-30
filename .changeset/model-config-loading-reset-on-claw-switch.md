---
"@coclaw/ui": patch
---

Fix model-config page getting stuck on the loading spinner when switching to a
disconnected claw mid-load

`ModelConfigPage` set/reset its `loading` flag only on the connected path of
`loadAll`, while the no-id / no-connection early returns ran before it. Switching
to a claw with no live connection while a prior load was still in flight left
`loading` stuck true (the old load was dropped by the seq guard without resetting
it, and the new load early-returned without touching it), so the page showed a
perpetual "loading" spinner instead of the offline/empty state. `loadAll` now owns
the `loading` lifecycle entirely: it is set before the early-return guards and
reset in a `finally` that runs on every exit path, gated by the existing load seq.
