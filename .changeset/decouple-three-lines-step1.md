---
"@coclaw/openclaw-coclaw": patch
---

fix(plugin): decouple server WS / gateway WS / WebRTC P2P lifecycles (step 1: pure decoupling)

Round 2 refactor for the realtime bridge. The three connections — external (plugin↔CoClaw server WS), internal (plugin↔local OpenClaw gateway WS), and P2P (WebRTC PC + DC routing tables) — are now lifecycle-independent.

Server WS non-auth-close (4000 / 1006 / 1011 etc.) no longer cascades to closing the gateway WS, clearing `__dcPendingRequests`, clearing `__runEventRoutes`, or canceling gateway retry/attempts. Auth-close (4001 / 4003) still tears down PC + fileHandler + token (plugin loses operating right) but no longer cascades to the gateway WS.

This is pure decoupling — no new behavior added. The push-splitting (action 3 in the plan) lands separately in step 2.
