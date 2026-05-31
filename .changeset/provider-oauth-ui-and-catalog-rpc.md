---
"@coclaw/openclaw-coclaw": minor
"@coclaw/ui": minor
---

Add provider OAuth device-code login UI and converge model-config on the three-capability model.

- Plugin: new `coclaw.providerAuth.catalog` RPC exposing the provider directory (auth methods + `hasCred`); rename `coclaw.model.listUsable` to `coclaw.model.listAvailable` (`listUsable` kept as a transitional alias) and drop `configuredProviders` from its output; `listAvailable` now returns `IO_FAILED` when the model catalog fails to load instead of an authoritative-empty list, so the UI does not misreport the primary model as invalid.
- UI: device-code OAuth login flow for providers (alongside API-key entry; OAuth login-redirect providers are listed but marked not-yet-supported), catalog-driven add-provider list, an OAuth badge on authenticated providers with credential-only revocation, and primary-model validity computed over the available list. Removes the heavy `models.list {view:'all'}` fetch and all old-plugin fallbacks.
