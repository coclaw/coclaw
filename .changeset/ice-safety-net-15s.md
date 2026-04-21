---
'@coclaw/ui': patch
---

Tighten ICE restart safety-net timer from 30s → 15s and add offer→answer RTT observability.

The safety-net timer re-sends an `rtc:offer` when neither the `connectionState` event path nor the 500ms stats-poll path has detected recovery — the canonical remaining case is a lost `rtc:answer` in the return path. Previously the worst-case recovery latency in that scenario was 30s; now it is 15s. Normal offer→answer RTT sits in the 1–3s range, so 15s retains an order-of-magnitude safety margin.

To ground future tuning in real data, this change records the timestamp at each `rtc:offer` send and, on arrival of the corresponding `rtc:answer` during `restarting`, emits both a local `__log('info', …)` entry and a structured `remoteLog('rtc.restartAnswer claw=… rtt=…ms attempt=…')` event.

No API or behavior change outside the ICE restart retry cadence; the field `__restartOfferSentAt` is cleared in `__clearRestartState` alongside the existing restart-state fields.
