---
'@coclaw/openclaw-coclaw': minor
---

Add provider-auth RPC handlers: `coclaw.providerAuth.setApiKey` writes an API key
profile via the OpenClaw Plugin SDK (no gateway restart), `coclaw.providerAuth.list`
returns bound profiles across api_key/oauth/token types with masked `keyPreview`
only, and `coclaw.providerAuth.remove` clears all profiles for a provider.
