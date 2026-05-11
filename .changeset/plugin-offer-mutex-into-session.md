---
"@coclaw/openclaw-coclaw": patch
---

Aggregate the per-connId offer mutex into the WebRTC session so the lock lifetime always tracks the session it serializes. The sync entry-gate in `__handleOffer` now performs the five-step atomic session-replace for non-ICE offers (detach handlers, clear timers, delete from map, fire-and-forget finalize, build new session), with `__handleOfferLocked` reduced to SDP negotiation only — including a new four-point identity recheck on the first-offer path that mirrors the ICE restart path. `closeByConnId` gains an `expectedSession` argument and short-circuits when the table no longer points to that session, closing the structural race between mutex deletion and concurrent offers without introducing reference counting or fire-and-forget cleanup of the close itself.
