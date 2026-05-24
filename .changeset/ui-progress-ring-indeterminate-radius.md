---
'@coclaw/ui': patch
---

refactor(ui): tighten ProgressRing indeterminate check and demote radius computed to const

`indeterminate` used to check only `value == null || Number.isNaN(value)`,
which missed `±Infinity` and non-Number runtime values. Anomalous inputs
would slip through `Math.min/max` clamping and paint a deceptive static
full/empty ring instead of the spinner that "we don't know the progress"
should display. Replaced with `!Number.isFinite(value)`, which covers
null, undefined, NaN, ±Infinity, and any non-number coerced through
runtime (string, object).

`radius` was a `computed` returning the literal `50` with no dependencies —
a Quasar q-circular-progress geometry constant that was never reactive.
Promoted to a module-level `const RADIUS = 50` (with intent comment),
inlined in the template `<circle r="50">`, and referenced from
`circumference()`. No runtime/visual change.

No call site is affected (all existing call sites pass real numbers in
`[0, 1]` or `null`); the indeterminate-check change is purely defensive
against anomalous runtime inputs.
