---
"@coclaw/ui": patch
---

Fix signal loss in `connected + restartPaused + typeChanged` path introduced by the per-claw Set refactor.

`WebRtcConnection.__attemptRestart`'s paused gate only accepts `reason === 'online_resume'`; all other reasons (including `'network_type_changed'`) are dropped. The previous per-claw Set implementation unconditionally `delete`d the Set entry and called `triggerRestart('network_type_changed')` in `__handleNetworkOnline`'s main loop for any `connected + typeChanged` claw. When the claw was also paused, this combination produced a silent signal loss: the restart was dropped and the record keeping was cleared, so the subsequent `__resumeOnline` had no way to know it should force a restart.

- `__handleNetworkOnline` main loop's `connected + typeChanged` branch now splits on `rtc.restartPaused`: paused claws skip the `triggerRestart` call and preserve the Set entry, so the eventual `__resumeOnline` consumer upgrades the recovery to `triggerRestart('online_resume')` (the only reason that bypasses the paused gate). Non-paused claws behave as before (`delete` + `triggerRestart('network_type_changed')`).
- `__ensureRtc` success path now calls `_pendingTypeChangedRestartClaws.delete(id)` — rebuild produces a fresh ICE path, so any pending typeChanged bookkeeping on that claw is stale and should not cause a spurious `triggerRestart('online_resume')` on the next resume event. Symmetric with the existing cleanup in the `!initialized` branches and `applySnapshot` / `removeClawById`.
- Rewrite the round-2 self-review test that asserted the buggy `triggerRestart('network_type_changed')` behavior, and add a control-group test for the non-paused path.
- `docs/architecture/communication-model.md` §5.5.1: document the paused-branch defer rule and enumerate all Set cleanup sites for future reviewers.
