---
"@coclaw/ui": patch
---

RTC recovery path gating — post-review fixes:

- **Boot-race recovery**: when SSE snapshot arrives before the signaling WS handshake completes, `__fullInit` is blocked by the sig gate and `initialized` rolls back to `false`. On sig reconnect, `__resumeAllClawsForSigOnline` now re-runs `__fullInit` for online-but-uninitialized claws, replicating the `updateClawOnline` `!initialized` branch (previously the flow left the claw half-initialized).
- **typeChanged cross-gate bookkeeping**: `network:online(typeChanged=true)` no longer lost when sig is offline. A module-level `_pendingTypeChangedRestart` flag is set at `__handleNetworkOnline` entry and consumed by `__resumeAllClawsForSigOnline`, which escalates `connected+paused` claws to `triggerRestart('online_resume')` (previous behavior `resumeRecovery()` left stale ICE path after WiFi↔cellular switch → ~30s consent timeout before passive restart).
- `pauseRestart()` log text: drop `(claw offline)` qualifier — the function is now shared by both claw-offline and sig-offline freeze paths, and callers already log the reason.
- `ui/docs/state-recovery.md`: sync to current `__handleClawGoOffline` behavior (removes stale mention of clearing `dcReady` / stamping `disconnectedAt` — the `4a05074` principle is that presence does not pollute DC lifecycle).
- `docs/architecture/communication-model.md` §5.5.1: append mental-model paragraph reframing the signaling WS as an end-to-end reachability probe rather than a business dependency, plus a description of the `_pendingTypeChangedRestart` bookkeeping.
