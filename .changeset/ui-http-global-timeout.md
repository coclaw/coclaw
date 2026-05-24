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

The remote-log channel keeps its own axios instance with separate
timing — unchanged. The same 60s ceiling does not affect WebRTC
DC RPCs which are not routed through this client.
