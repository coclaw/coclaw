---
"@coclaw/ui": patch
---

RTC recovery — per-claw typeChanged restart bookkeeping:

- Replace module-level boolean `_pendingTypeChangedRestart` with per-claw Set `_pendingTypeChangedRestartClaws`. The boolean was consumed in a single spot (`__resumeAllClawsForSigOnline`), which missed two real-world paths where the typeChanged signal would be silently dropped:
  - **sig online + claw offline + typeChanged**: main loop's `!claw.online continue` dropped the signal; subsequent `updateClawOnline(id, true)` default-resumed via `resumeRecovery()`, leaving the old (invalid) ICE path to hit ~30s consent timeout.
  - **sig offline + typeChanged + sig resume while claw still offline**: the boolean was consumed at sig resume and the signal was lost; later claw-online would default-resume on stale ICE.
- `__handleNetworkOnline(typeChanged=true)` now records every claw that will NOT be immediately `triggerRestart`-ed by the main loop (offline / paused / restarting / failed / not initialized / sig offline). `__resumeOnline(id)` consumes the Set entry via `delete(id)` and treats a hit as `forceRestartOnConnected=true`.
- Consistency: clean Set entries at all claw-lifecycle exit or recovery points to prevent stale entries from causing spurious `triggerRestart('online_resume')` on already-healthy connections:
  - `removeClawById` / `__resetClawStoreInternals` (logout) / `applySnapshot` cleanup loop
  - `updateClawOnline` `!initialized` branch (full init = fresh ICE path)
  - `__handleNetworkOnline` main loop success branches (`restarting → nudgeRestart`, `connected && typeChanged → triggerRestart('network_type_changed')`, `failed/closed → rebuild`)
  - `__resumeAllClawsForSigOnline` `!initialized` branch
- `__resumeAllClawsForSigOnline` `force_restart` diagnostic counter moved to the `initialized` branch (the only path that actually consumes the Set via `__resumeOnline`), so `!initialized` claws no longer inflate the count.
- `docs/architecture/communication-model.md` §5.5.1: rewrite the typeChanged bookkeeping paragraph to describe the per-claw Set and list the three newly covered paths.
- `docs/designs/ice-restart-recovery.md` §6.5 and `ui/docs/state-recovery.md`: remove stale mentions of clearing `dcReady` / stamping `disconnectedAt` on offline (commit `4a05074` already made presence orthogonal to DC lifecycle; these doc lines had not been synced).
