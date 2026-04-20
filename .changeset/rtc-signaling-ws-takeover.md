---
'@coclaw/server': patch
---

fix(rtc): take over orphaned signaling WS on client reconnect

When a UI instance switches networks (e.g. WiFi↔cellular), it closes its old
signaling WS and opens a new one, reusing the original connId to preserve ICE
restart semantics on the plugin side. The server previously refused any
`rtc:offer` on the new WS with `connId=... occupied by another WS`, because the
orphaned half-open WS still held the connId in the routing table. Every ICE
restart attempt (6 × ~15 s) failed, forcing UI to fall back to a full PC rebuild.

**Root cause**: `register()` in `rtc-signal-router.js` rejected on `existing.ws
!== ws`, and there is no server-side heartbeat on the signaling WS today — so a
half-open WS lingers until the kernel's TCP keepalive kicks in (hours).

**Fix**: Upgrade `register()` to interpret a connId collision (new ws + same
userId + same clawId) as "the same UI instance has migrated to a new WS." When
triggered, it atomically rewrites every connId on the old WS to point at the
new WS, then `terminate()`s the old WS. This matches the intent of
`claw-ws-hub.js`'s existing stale-socket cleanup on the plugin side. The
`rtc:ice` / `rtc:ready` paths get the same takeover when `route.ws !== ws`, so
the fix is symmetric regardless of which signaling frame arrives first after
reconnect.

**Safety**:

- `existing.userId !== userId` still rejects. connId is a UUID v4 generated
  by the UI, so a collision across users can only happen as a cross-user
  forgery attempt; `userId` is the true safety boundary.
- `removeByWs()` now guards each deletion with `entry.ws === ws` to prevent the
  old WS's delayed `close` event from wiping routes that the new WS already
  took over. The `rtc:closed` handler applies the same guard before removing.
- `register()` return type changes from `boolean` to `{ok, migrated}` so the
  hub can emit a `signal ws takeover` info log on the rare takeover path.

Out of scope: server-side heartbeat for the signaling WS (separate follow-up).
