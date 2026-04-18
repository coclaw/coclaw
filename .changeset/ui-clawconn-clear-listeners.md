---
'@coclaw/ui': patch
---

fix(ui): clear event listeners on ClawConnection.disconnect

Chat store registers an `event:chat` handler on the per-claw ClawConnection.
At logout, chat-store's cleanup path tries to `conn.off(...)` but the
connection manager has already removed the conn, so `__getConnection()`
returns null and the off path is skipped. The handler closure stays on
`ClawConnection.__listeners`, pinning the chat store proxy (and its
streaming buffers) until the ClawConnection itself is GC'd.

Currently this still releases because disconnected ClawConnections have
no other strong references, but the release is indirect and will break
if someone later adds a self-referencing timer to ClawConnection.
Clearing the listener map in `disconnect()` is a one-line defensive fix
that makes the intent explicit and does not rely on GC timing.
