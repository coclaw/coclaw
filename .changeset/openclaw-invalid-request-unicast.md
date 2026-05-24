---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin/realtime-bridge): unicast INVALID_REQUEST response to the originating DC instead of broadcasting

When a peer sends a malformed `req` frame (valid `id` but missing or
invalid `method`), the bridge replied with an `INVALID_REQUEST` `res`
frame broadcast to every connected DC. Other peers received an error
response they never asked for and had to discard it.

The handler already has the originator `connId` in scope (passed by
`WebRtcPeer.__onRequest` callback). Switch the reply to
`await this.webrtcPeer?.sendTo(connId, frame)` so only the originator
sees it. `sendTo` handles closed/missing sessions internally and the
outer caller already has a `.catch` net.

The adjacent `GATEWAY_OFFLINE` and `GATEWAY_SEND_FAILED` branches keep
their broadcast semantics — they represent system-level status the
caller may not be able to attribute, so a one-shot broadcast remains
the safer behaviour there (per upstream review).

Adds a dedicated red test asserting `INVALID_REQUEST` is only seen by
the originating `connId` and that `broadcast` is never called for this
branch; the pre-existing id/method validation test is updated to use
the new mock surface (`sendTo` alongside `broadcast`).

Also drops the **dc-chunking msgId uint32 wrap** TODO entry: assessed
as practically unreachable (~1.36 years of continuous 100/s chunked
RPC at one session before overflow, with every disconnect / ICE
restart resetting the counter), so it does not warrant a defensive
patch.
