---
'@coclaw/ui': patch
---

fix(rtc): detect ICE restart success via getStats ufrag comparison

On APK network switches (e.g., WiFi↔cellular) the UI triggers an ICE
restart while the old candidate pair is still healthy. The restart
completes cleanly end-to-end (plugin's pion reports the new pair as
connected, stats show the new `relay/udp>prflx/udp` pair nominated and
succeeded, DataChannel keeps flowing), but the browser's
`connectionState` never leaves `connected` throughout, so
`onconnectionstatechange` is never fired and the UI stays stuck in
`restarting`, sending periodic offers until the 90s timeout and finally
falling back to a full PC rebuild. The MainList spinner stays on the
whole time despite chat continuing to work.

Add a parallel stats-poll detection path. At restart trigger we
snapshot the current selected pair's local-candidate `usernameFragment`
via `getStats()` (per ICE spec each restart mints a new ufrag). While
in `restarting`, a 500 ms `getStats()` poll looks for a nominated
succeeded candidate-pair whose local ufrag differs from the snapshot —
that is exactly the same invariant the browser uses to keep
`connectionState=connected`, just observed via polling instead of
waiting for a state-change event that will never fire. On match we
declare `ICE restart succeeded via=stats` and run the usual transitions
(`__clearRestartState`, `__setState('connected')`, `__startKeepalive`,
`__resolveCandidateType`, `stats.post-restart-success` after 2s). The
existing event path is untouched (now logs `via=event` for
disambiguation) and handles the "old pair already failed" scenario as
before. If `getStats()` cannot produce a pre-restart ufrag we disable
the stats path for that cycle (no comparison baseline → no false
positives).

Additional hardening from a second deep-review pass:

- `__checkRestartViaStats` now captures `epochAtEntry` and rejects
  cross-epoch late ticks after the `getStats` await (symmetric with
  the snap.then epoch guard). Closes a narrow TOCTOU where the event
  path wins a restart and an immediate `triggerRestart` opens a new
  epoch while the previous tick's getStats is still in flight.
- Multi-nominated-pair handling: the check now aggregates **all**
  nominated+succeeded pairs' local candidates and declares success if
  **any** local ufrag differs from the snapshot. The earlier
  "first-match" loop could stay pinned on the stale pair during the
  short migration window when the browser reports both old and new
  pair as nominated+succeeded simultaneously.
- SDP-ufrag fallback for cross-browser compatibility: when
  `RTCIceCandidateStats.usernameFragment` is unavailable (some Safari
  and older Firefox builds), both snapshot and check now fall back to
  parsing `a=ice-ufrag:` from `pc.localDescription.sdp`, which the SDP
  spec mandates. Snapshot captures the SDP ufrag synchronously before
  the `getStats` await, so it reflects the pre-restart SDP regardless
  of when the stats resolve.
