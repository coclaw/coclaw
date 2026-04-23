---
"@coclaw/ui": patch
---

Three round-8 external review fixes covering pre-existing and current-branch gaps:

- `webrtc-connection.js` `rtc:restart-rejected` handler now ignores the message unless the PC is currently in the `'restarting'` state. Rationale: the signaling `connId` is reused per claw (not per ICE restart generation); after a rebuild, the new `WebRtcConnection` instance's signaling listener still receives a late `rtc:restart-rejected` from the previous restart attempt. Without this guard the stale reject would call `close({ asFailed: true })` on the newly rebuilt PC, producing a spurious failed→rebuild cycle. The guard is UI-side only — no protocol change on plugin — and logs `rtc.restartRejectedStale` to remoteLog for diagnostics. This is a pre-existing gap (introduced with the ICE restart-first strategy in `db12a17`), surfaced by round-8 review; folded into this batch because the fix is small and self-contained.

- `claws.store.js` `__handleNetworkOnline` now wakes up claws stuck in `rtc=null` + (`rtcPhase='failed'` or `!dcReady`). Previously these were skipped by the `if (!rtc) continue` early-out. After retry exhaustion the backoff timer is still scheduled, so recovery eventually happens — but the next scheduled retry typically uses an already-stale ICE path (WiFi↔cellular just changed), so waiting for the backoff window to elapse is pure lost time. The new branch clears retry state, flips `rtcPhase='recovering'`, and calls `__ensureRtc(id)` directly, cutting the recovery delay on network transitions. Defensive: if `rtc=null` but `rtcPhase='ready'` and `dcReady=true` (an inconsistent combination that shouldn't exist), the handler still skips.

- `ui/docs/state-recovery.md` §7.x network debounce paragraph updated to describe the actual implementation (1200ms trailing-edge debounce with OR-aggregation on `typeChanged`) rather than the old 500ms leading-edge content-aware dedup. The code already has design-rationale comments in `src/utils/network-debounce.js`; this just re-syncs the doc.

Tests: three new `__handleNetworkOnline` cases covering `rt=null + rtcPhase=failed`, `rt=null + !dcReady + rtcPhase=recovering`, and the defensive skip branch; one new `rtc:restart-rejected` test asserting the stale-message guard preserves a connected PC. The existing `rtc=null → 跳过` test description was clarified to reflect that `!initialized` is the short-circuit in that specific scenario.
