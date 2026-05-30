---
"@coclaw/openclaw-coclaw": patch
---

Fix OAuth-only providers (e.g. `openai-codex`) being dropped from the model
picker's usable list

`coclaw.model.listUsable`'s provider gate (`computeProviderUsableByName`) only
recognized API keys: `isProviderApiKeyConfigured` (env + the api-key credentials
in the auth-profile ledger) and inline `cfg.models.providers[].apiKey`. A provider
authenticated purely via OAuth (codex, and device-code family providers like
copilot) has only an `oauth`/`token` ledger credential and no key, so both probes
returned false and `enumerateUsableModels` dropped its whole model group from
`byProvider` — the picker listed nothing for it. This contradicted the same RPC's
`configuredProviders`, which reads the full ledger and recognized the provider.

The gate now also consults the auth-profile ledger for any well-formed profile
whose provider matches the queried provider after alias normalization (mirroring
`computeConfiguredProviders`), so `oauth`/`token` credentials count as usable. The
primitive stays synchronous and the dependency injection is unchanged
(`ensureAuthProfileStore` + `resolveProviderIdForAuth` were already wired in). The
api-key checks still short-circuit first, so providers with keys never pay the
extra ledger read. Root cause of the workaround: upstream plugin-sdk does not
export a full-coverage `hasAuthForModelProvider`, so CoClaw composes the gate from
api-key probes and was missing the OAuth path.
