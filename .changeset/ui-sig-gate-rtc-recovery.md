---
"@coclaw/ui": patch
---

Freeze all claws' ICE restart / rebuild budget when the signaling WS is not connected (electric elevator, airplane mode, WiFi drop, server restart, etc.). Introduces a second lock (`_sigOffline`) parallel to the existing `claw.online` lock: recovery actions resume only when both locks are open. Frozen state keeps the PC and clears the per-claw retry budget; on WS reconnect, online claws are dispatched through the existing `__resumeOnline` path (ICE restart / rebuild / noop by PC state).
