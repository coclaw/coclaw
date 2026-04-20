---
'@coclaw/openclaw-coclaw': patch
---

fix(rtc): filter gateway admin-broadcast events from DC forwarding + expand ICE gathering diagnostics

Two small, complementary changes on the plugin side:

**Gateway event filter (`realtime-bridge.js`)**

The bridge currently forwards every `res` / `event` frame from the
gateway WS to every open rpc DataChannel. Two gateway-maintenance events
carry no business meaning for WebChat / plugin clients but are pushed
unconditionally on a timer:

- `health` — a full state snapshot (~3 KB: channels, every agent,
  recent sessions, stateVersion) broadcast on a 60 s tick and again on
  every client-issued `health` RPC. Intended for the Admin UI
  dashboard.
- `tick` — gateway WS keepalive, emitted every 30 s. The DC side
  already has its own transport probe (`probe` / `plugin-probe`) so
  the UI does not need it, and it is piggy-backed through the DC for
  no purpose.

When the Android APK is backgrounded the WebView stops draining the
DC; these two streams alone fill the plugin's 10 MB app-layer send
queue in ~1–2 h, after which real events start being dropped. The
upstream gateway has no subscription mechanism for filtering event
broadcasts per client (not in `EVENT_SCOPE_GUARDS`), so until that is
added we drop both event names at the bridge before they reach
`webrtcPeer.broadcast`. `res` frames and all other events are
forwarded unchanged.

**ICE gathering diagnostics (`webrtc-peer.js`)**

Under pion-node the existing `rtc.ice-gathered` summary never emits
because pion does not fire `onicecandidate(null)` at gather-complete.
Install an `onicegatheringstatechange` handler as a fallback: on the
`complete` state transition we flush the same summary, guarded against
double-emission when the null-candidate path fires too (e.g. werift).
The summary now also includes a `hosts=addr:port,...` list for each
host candidate so we can observe whether pion is gathering docker /
bridge / loopback interfaces as host candidates. The `gathering` state
resets the flag so ICE restart cycles also get a fresh summary.

**Diagnostic logs in `rpc-send-queue.js`**

Commented-out `info` payload dumps left in place (one on every queued
message, one on queue-full drop) so they can be temporarily enabled to
sample what the gateway is still pushing without editing the release
build.
