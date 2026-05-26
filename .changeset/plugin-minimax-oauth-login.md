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
(dynamic per-account `baseUrl` + model list) through `mutateConfigFile` with
`afterWrite:auto` — a hot-reload path, so no gateway restart and no dropped RTC/run.

The model list is required for the models to be usable: OpenClaw's bundled MiniMax
extension only injects its static catalog during a provider-scoped discovery pass
that a third-party binding cannot trigger, so without an explicit model list the
provider shows zero models (unusable in the picker and rejected by
`coclaw.model.set`). The plugin writes a small built-in static catalog
(`MiniMax-M2.7` + `MiniMax-M2.7-highspeed`, matching upstream's hand-maintained
`MINIMAX_TEXT_MODEL_ORDER`) rather than fetching `/models` over the network — the
live endpoint returns several older model generations the user does not want, and
a login-time fetch is no fresher than a static table (it goes stale until the next
login anyway). Each entry carries only the minimal runtime metadata
(`reasoning`/`contextWindow`/`maxTokens`, aligned with upstream's
`model-definitions.ts`; no `cost`, since the portal runs on a token plan rather
than usage-based billing). `reasoning` in particular must be written — a missing
flag defaults to false and a reasoning model would be handled as an ordinary one.

To keep already-bound users in sync when the plugin ships new models, the gateway
reconciles the bound provider's `models[]` against the built-in table on startup.
It writes only when the config does not already cover every built-in model id
(matched by id alone): if another source — e.g. the official MiniMax plugin — later
writes its own, larger list into the same provider, the config is treated as a
superset and left untouched instead of being overwritten (and the gateway
re-restarted) on every startup. A no-op whenever the ids are already present, so
config writes — and any future restart-on-write behavior — happen at most once.

The device-code flow is replicated from the upstream MiniMax extension (shared
client_id / endpoints / scope) with injectable `fetch` for offline unit tests.
The background poll self-terminates within an independent hard window so an
oversized server-supplied `expired_in`/`interval` can no longer make it poll
unbounded or leak the in-flight registry entry (a stalled individual request
still relies on the underlying `fetch`'s own timeout). Server-returned token
expiry and `resource_url` are type-validated before use, and each terminal
outcome emits a low-frequency diagnostic log.
