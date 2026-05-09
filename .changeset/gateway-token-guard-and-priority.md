---
"@coclaw/openclaw-coclaw": patch
---

Skip realtime bridge startup when no gateway auth token is resolvable, and align the default token resolver with the upstream server's priority. The bridge's `service.start` entry now bails out early (with a single `info` log) instead of opening the inner-line WebSocket and producing `token_missing` noise on the gateway. The default resolver (`defaultResolveGatewayAuthToken`) reads `config.gateway.auth.token` first and falls back to the `OPENCLAW_GATEWAY_TOKEN` env variable, mirroring the upstream `auth-surface-resolution` order so a stale env value can no longer mask a fresh config token.
