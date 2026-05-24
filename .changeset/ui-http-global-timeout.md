---
'@coclaw/ui': patch
---

fix(ui): set a 60s global timeout on the shared REST httpClient

The shared `axios` instance had no `timeout` set, which means a
stalled response (server 5xx hang, half-closed TCP the kernel hasn't
reaped, oversized proxy buffer) would leave the calling page
spinning forever with no self-recovery path. All current REST
endpoints (auth, user info, TURN credentials, web bots, server
info, admin) return well under one second on the happy path, so a
60s bound is comfortably generous while still bounding the worst-
case user wait.

Scope of the 60s ceiling — only the shared REST httpClient. Not
affected (each has its own timing):

- SSE event streams use the browser-native `EventSource` (user
  status, claws status, admin) — no axios path
- The signaling channel uses the browser-native `WebSocket` with
  its own heartbeat / reconnect / connect timeout
- WebRTC DataChannel RPCs are routed through `ClawConnection` with
  its own two-layer timeout model (connectTimeout / requestTimeout)
- The remote-log channel keeps a separate axios instance with its
  own pacing
