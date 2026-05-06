---
'@coclaw/openclaw-coclaw': patch
---

Fix `FileBackedQueue` so `bypassAdmission`-eligible messages keep getting accepted into the in-memory tier while the queue is in the sticky `fsBroken` degraded mode, mirroring the `MemoryQueue` overshoot semantics.

Before this fix, once `fsBroken` latched (sticky after any spill IO failure), the in-memory tier became the de facto capacity layer because spill was permanently disabled. But the bypass exemption was anchored only to the `diskCap` admission gate, not to the in-memory `memBudget` gate — so once the in-memory tier filled, even agent-response (`type === 'res' && payload.runId`) frames fell through to the `fsBroken` short-circuit and were dropped with reason `fs-error`. Pure `MemoryQueue` would have kept accepting those same bypass-eligible messages via overshoot, so the two implementations diverged precisely where users see degraded service.

The fix narrows the divergence: in `fsBroken` mode, when the in-memory tier is full and the message hits `bypassAdmission`, FBQ now overshoots `memBudget` and accepts the message. Healthy-path behavior is unchanged — bypass-eligible messages still spill to disk normally when the in-memory tier fills under healthy IO, so spill is not bypassed for ordinary load. Bypass still does NOT exempt the actual write-IO failure (mkdir / writeStream emit error / write callback err) that initially latched `fsBroken`; only the post-latch capacity layer is exempted.

Docs and the `bypassAdmission does NOT exempt physical IO failure` test are updated to match the corrected red-line-3 semantics: bypass exempts the capacity layer (including degraded-mem-only mode), but never the actual write attempt nor the per-message `oversize` cap. A new red-then-green test (`bypass admission overshoots memBudget under fsBroken`) pins the new behavior.
