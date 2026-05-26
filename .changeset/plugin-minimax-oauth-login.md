---
'@coclaw/openclaw-coclaw': minor
---

feat(plugin): add MiniMax OAuth login (device-code) provider-auth RPCs

Add `coclaw.providerAuth.loginOauth` and `coclaw.providerAuth.cancelOauth` so
users can sign into MiniMax ("token plan"; default cn region, global also
supported) by scanning/approving a device code, completing the provider-auth
family (API key set/list/remove was already shipped; OAuth was the last gap).

`loginOauth` is a true two-phase RPC: phase-1 immediately returns an `accepted`
frame with the verification URL + user code, and a background poll loop later
sends the final frame on the same request id (success / error / timeout /
cancelled). `cancelOauth` mirrors `agent.abort` — a single-shot abort of the
in-flight login. On success the plugin writes an OAuth credential via the
locked `upsertAuthProfileWithLock` and writes `models.providers.minimax-portal`
(dynamic per-account `baseUrl`) through `mutateConfigFile` with `afterWrite:auto`
— a hot-reload path, so no gateway restart and no dropped RTC/run. Running the
model itself is handled by OpenClaw's bundled MiniMax extension; CoClaw only
produces the credential + provider config — the same end state an upstream OAuth
login writes, minus the optional default-model aliases (left to `coclaw.model.set`).

The device-code flow is replicated from the upstream MiniMax extension (shared
client_id / endpoints / scope) with injectable `fetch` for offline unit tests.
