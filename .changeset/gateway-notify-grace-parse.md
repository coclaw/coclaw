---
'@coclaw/openclaw-coclaw': patch
---

Fix `callGatewayMethod` helper losing the parsed payload when the upstream
`openclaw gateway call --json` writes a pretty-printed JSON response in
multiple chunks. Previously, when the accumulated stdout happened to
`startsWith('{')` and `endsWith('}')` at the moment a nested object closed
(but the outer object was still incomplete), the grace-period timer was
armed with a frozen `parseResult()` snapshot — which had fallen back to
`{ ok: true }` (no payload) because the JSON was not yet complete. Any
later chunks completing the JSON arrived too late to be reflected in the
resolved result.

`parseResult()` is now invoked when the grace timer fires, not when the
grace period starts, so the final stdout (including any in-flight chunks
that arrive during the grace window) is parsed.

No public API change. CLI callers that read `result.payload.*` (e.g. the
provider-auth / model-default / bind / unbind / enroll CLI handlers) get
the full payload reliably even when stdout is delivered in chunks.
