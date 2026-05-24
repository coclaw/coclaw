---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin): pre-validate slash `/coclaw bind` code before cancelling active enroll

The slash command `/coclaw bind` previously delegated to `doBind`
unconditionally, even when no positional code was supplied. `doBind`
always calls `cancelActiveEnroll()` up front, so an empty/invalid
slash bind would tear down an in-flight enroll before the
`bindClaw()` error surfaced. The slash handler now rejects a missing
or empty code with `Error: binding code is required` before reaching
`doBind`, so an in-progress enroll is preserved when the user
mistypes the command. The error text matches the prior bubble-up
message; only the side effect is gated.
