---
'@coclaw/ui': patch
'@coclaw/openclaw-coclaw': patch
---

feat(rtc): expand ICE restart diagnostics on both UI and plugin

Investigating a reproducible failure where a backgrounded APK (~20 min) comes
back foreground, the plugin's pion reports `ice connection state: connected`
for every ICE restart, but the UI's RTCPeerConnection never fires another
`connectionState=connected` and eventually gives up, forcing a full PC rebuild.
Existing logs could not distinguish between "ICE agent never left checking",
"new pair nominated but DTLS transport did not migrate", and "WS/signaling
lost an ICE candidate". This change adds a minimal, low-noise set of log
anchors plus a bidirectional plugin-initiated probe so the next reproduction
can be diagnosed without further instrumentation.

UI (`ui/src/services/webrtc-connection.js`):

- Wire the previously absent `iceconnectionstatechange`, `icegatheringstatechange`,
  `signalingstatechange`, and `icecandidateerror` handlers; each emits a single
  `remoteLog` line on state change. `iceconnectionstatechange` exposes the
  ICE-only `checking/connected/failed` transitions that `connectionState` hides.
- Classify each local ICE candidate by `typ` (host / srflx / relay / prflx) and
  emit a `iceGathered host=N srflx=N relay=N prflx=N` summary when gathering
  completes. Counters reset at each `gathering` entry (including ICE restart).
- `__attemptRestart` now logs a `restart.trigger reason=... connState=...
  iceState=... sigState=... dc=[...] dcIdleAgo=... attempt=N` snapshot on the
  first entry of each restart epoch, making it possible to distinguish "we
  fired restart while UI still believed itself connected" from "UI already
  went to failed".
- New `__dumpStats(reason)` helper walks `getStats()` and emits one line
  summarising the nominated candidate-pair (state / nominated / bytes /
  RTT / STUN req-resp counts), DTLS+ICE transport state and bytes, and
  rpc DataChannel stats (state / messages / buffered). Called at four
  points: before the first restart offer, 3s after a restart-answer is
  applied, on restart-timeout (awaited before close), and 2s after a
  `connectionState=connected` restart-success.
- New `plugin-probe` frame type on the rpc DC: when the plugin sends one,
  the UI echoes `plugin-probe-ack` (bypassing the send queue, same as the
  existing UI→plugin `probe-ack` path) and logs the echo.

Plugin (`plugins/openclaw/src/webrtc/webrtc-peer.js`):

- Wire `oniceconnectionstatechange` on pion PCs (guarded by `in pc` so werift
  is unaffected); emit `rtc.iceState conn=X <state>` on each transition, and
  detach the handler in `closeByConnId` alongside the other listeners.
- Log `rtc.restart-answer-sent conn=X` after a successful ICE restart answer
  is emitted, mirroring the existing `rtc.ice-restart` on the receive side.
- On `pion` PC transition to `connected` when the previous dump state was
  `disconnected`/`failed` (i.e. an ICE restart just recovered): run one
  `rtc.dump state=connected` snapshot of the current session, then schedule
  a `plugin-probe` on the rpc DC with a 500 ms delay. The probe is bypasses
  the send queue, tracks a single in-flight id per session, and logs the
  RTT on `plugin-probe-ack`, a `timeout` line after 5 s unref'd, or a
  `send-failed` line if `dc.send` throws. `closeByConnId` clears the
  in-flight probe timer so a late timeout does not fire after session
  teardown. The branch is gated on `impl === 'pion'` so werift/ndc
  compatibility paths are untouched.

No existing recovery/retry/rebuild behaviour is changed; this commit is
purely additive instrumentation plus the symmetric probe plumbing.
