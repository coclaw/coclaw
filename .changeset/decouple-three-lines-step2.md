---
"@coclaw/openclaw-coclaw": patch
---

fix(plugin): re-push instance info on outer line up when inner line already ready (step 2)

Round 2 step 2 follow-up to the three-line decoupling. Previously `__pushInstanceInfo` was triggered only on inner line (gateway WS) connect-ok. After step 1 the inner line can become ready before the outer line (CoClaw server WS) — that first broadcast then drops on the server path because `__forwardToServer` rejects sends while the outer line is still down.

This change adds a guarded re-push at outer line `sock.open`: when `gatewayReady === true` we call `__pushInstanceInfo` again so the server / admin dashboard sees the plugin's `name / hostName / pluginVersion / agentModels` as soon as the outer line comes up. The guard is essential — `__pushInstanceInfo` collects `agentModels` via the gateway `agents.list` RPC, so pushing while inner line is down would emit incomplete data.

Naming note: this is "re-push" semantics, not a true split — the inner-line trigger remains in place. The "splitting" framing in the step 1 changeset was approximate.
