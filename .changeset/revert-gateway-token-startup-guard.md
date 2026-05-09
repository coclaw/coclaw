---
"@coclaw/openclaw-coclaw": patch
---

Remove the realtime-bridge startup gate that skipped bridge creation whenever the resolver returned no gateway auth token. The gate broke users running OpenClaw with `gateway.auth.mode: "none"` (an officially supported loopback-only mode) — for them no token is the *correct* state, but the gate stopped the bridge and made remote chat unusable. The bridge's gateway-connect path already handles an empty token gracefully (omits `auth` in the connect request), so the gate's only effect on those users was the regression. Restoring the previous behaviour makes the bridge start in `service.start` regardless of token presence; the existing retry/give-up table remains the bound on first-install token-missing noise.
