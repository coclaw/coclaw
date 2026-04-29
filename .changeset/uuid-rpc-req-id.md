---
'@coclaw/ui': patch
---

Use a uuid-based prefix for DC RPC request ids so they are unique across `ClawConnection` instances.

Each `ClawConnection` now generates one `crypto.randomUUID()` at construction time and reuses it as the prefix for every RPC sent over its rpc DataChannel. The new id format is `ui-<uuid>-<counter>` (was `ui-<Date.now()>-<counter>`), where `counter` is still the per-connection monotonic sequence kept for log readability. Same-instance ids share the uuid; cross-instance ids never collide, even when multiple tabs open simultaneously and start their counters from 1.

This is Phase 1 of the unicast change documented in `docs/designs/dc-rpc-response-unicast.md`. Phase 2 will land in `@coclaw/openclaw-coclaw`, which will use the now-unique reqId to record `reqId → connId` and unicast gateway-forwarded RPC responses back to the originating peer instead of broadcasting them to every connected UI. Until that plugin change ships, behavior is unchanged on the wire — the plugin does not parse the id format, so old plugins remain fully compatible with the new UI.
