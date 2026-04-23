---
"@coclaw/ui": patch
---

Skip immediate refresh in `__resumeOnline` forceRestart branch to avoid wasting RPC on a failing ICE path, and tighten `addOrUpdateClaw` to refuse `online` overrides.

Two hardening fixes from external review round 5:

- `__resumeOnline` refresh dispatch refactored to three branches. When `forceRestartOnConnected` is true (typeChanged per-claw Set consumed or explicit opts), skip the immediate `__refreshIfStale({force:true})` entirely — the old ICE path is known to be failing (WiFi↔cellular IP change), so the RPC would only burn 30s of application-layer timeout on a dead SCTP path. ICE restart itself keeps SCTP continuous, and `onRtcStateChange('connected')`'s `wasDisconnected=false` branch already skips refresh by design, so there is nothing to recover after restart — by design, not a bug. Non-forceRestart `connected`/`restarting` still refresh immediately; rebuild paths still defer via `_pendingForceRefreshOnRebuild`.
- Introduce `GATED_FIELDS = new Set(['online'])` to explicitly reject `online` overrides from `addOrUpdateClaw`. Currently server `claw.bound` / `claw.nameUpdated` payloads do not carry `online`, but that is an implicit contract — UI-side `online` transitions must go through `updateClawOnline` / `applySnapshot`'s diff to trigger pause/resume/retry gate side-effects. `online` is deliberately **not** added to `RUNTIME_FIELDS`, because `applySnapshot` Phase 2 must let snapshot's authoritative `online` override `existing.online` for Phase 3's true↔false diff to work.
- Updated `docs/architecture/communication-model.md` §5.5, `docs/designs/ice-restart-recovery.md` §6.5, and `ui/docs/state-recovery.md` RTC 前台恢复策略 to reflect the three-branch refresh dispatch.
- Added two unit tests covering the new forceRestart skip path (immediate refresh bypassed, pending rebuild Set not polluted) and the `addOrUpdateClaw` online rejection.
