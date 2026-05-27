---
"@coclaw/openclaw-coclaw": minor
---

feat(openclaw): generic device-code OAuth login for external providers

`coclaw.providerAuth.loginOauth` now accepts a `provider` param and drives the
upstream provider plugin's own `device_code` login method instead of
hand-reimplementing each flow. It resolves the provider via the
`provider-catalog-runtime` SDK seam (`resolvePluginProviders`, always
`activate:false` so it stays a zero-side-effect read), runs the method with a
capture-prompter context, and turns its verification note into the existing
two-phase RPC (phase-1 `accepted` carrying `verificationUri` / `userCode` /
full `rawText`, phase-2 final after credentials persist). Extraction is fully
fault-tolerant — when the URL or code can't be parsed the structured fields are
`null` and the raw upstream text is always forwarded for the UI to handle.

This is not hardcoded to specific providers: any provider exposing a
`kind: 'device_code'` auth method works automatically (currently GitHub Copilot
and OpenAI Codex's device-code method), so future upstream device-code
providers are covered without changes. `minimax-portal` is explicitly excluded
and keeps its existing self-contained flow (it also writes a static model
catalog). Loopback/paste-back OAuth methods are refused. `cancelOauth` is
reused as-is.
