---
"@coclaw/ui": patch
---

fix(ui): unify claw id whitespace normalization across applySnapshot and addOrUpdateClaw

`__validateClawId` already trims and rejects empty / sentinel ids, but
`applySnapshot` was discarding the trimmed return value and using
`String(b.id)` as the `byId` key, so an id like `'  bot-1 '` from the
snapshot path landed under a different key than the same id arriving
through `addOrUpdateClaw`. Snapshot now consumes the validated id as both
the `byId` key and the `createClawState` input, and `addOrUpdateClaw` now
also passes the validated id into `createClawState` so `state.id` matches
the `byId` key on the insert path.
