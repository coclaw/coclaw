---
'@coclaw/ui': patch
---

fix(ui): debounce network:online to collapse Android WiFi toggle double-restart

Android emits a brief wifi→cellular→wifi transition when the user toggles the
WiFi switch; each transition is a distinct `typeChanged` event. The previous
source-level dedup (500ms window, leading-edge) explicitly bypassed the window
for `typeChanged=true`, so each transition fired a full ICE restart. Plugin
logs showed two restart offers within the same second, and in rarer cases
three offers collided mid-renegotiation, tripping pion's
`have-remote-offer->SetRemote(offer)` guard and forcing a full PC rebuild.

Replace the leading-edge dedup with a trailing-edge debounce (1200ms window)
that merges all events in the window and OR-aggregates `typeChanged` — any
transition within the window promotes the final dispatch to
`typeChanged=true`, preserving the consumer's "strong signal → full restart"
decision even when the final network type equals the starting type. The
per-event `typeChanged` computation in the listener is unchanged
(incremental comparison against `_lastConnectionType`), so wifi→cellular→wifi
remains correctly classified as a type change end-to-end. Window size chosen
from observed samples where the two events were 500-900ms apart.

Additional hardening from a deep-review pass: extracted the debounce
state/helpers into a standalone `network-debounce.js` module (no Capacitor /
Nuxt UI deps), so the logout cleanup chain in `auth.store` can cancel any
in-flight debounce timer without pulling heavy imports into tests that touch
auth. Without the cancel, a logout happening inside a 1.2s debounce window
would let the pending event fire 1.2s later against the already-reset
environment — low real-world impact but trivial to eliminate at the source.
