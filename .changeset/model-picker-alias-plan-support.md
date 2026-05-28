---
"@coclaw/openclaw-coclaw": minor
"@coclaw/ui": minor
---

Support alias-plan models in the model picker and unify credential checks

The model picker can now list and select "alias-plan" variant models (e.g.
`volcengine-plan/ark-code-latest`), where a single base-provider key authorizes
both the base provider and its plan variants through the vendor manifest.

Plugin:
- Adds `coclaw.model.listUsable`, which enumerates selectable models from
  OpenClaw's clean model catalog (`loadModelCatalog` read-only) intersected with
  an alias-aware credential check, and returns the alias-normalized set of
  already-configured providers so the "add provider" flow can exclude both base
  and variant ids.
- `coclaw.model.set` now gates on the same alias-aware credential primitive
  (covering ledger, inline `openclaw.json`, and environment-variable keys) instead
  of the ledger-only check — fixing providers that were selectable but not
  settable — while still rejecting providers with no usable credential. Existence
  is validated against the same clean catalog as the picker, so anything
  selectable is settable.
- The noKey guidance signal (`hasAnyUsableCredential`) now also counts
  environment-variable keys.

UI:
- The model picker consumes `coclaw.model.listUsable` and excludes already-configured
  providers (base and variant) via the plugin's alias-normalized set, falling back to
  the previous `providerAuth.list ∩ models.list` derivation when talking to an older
  plugin that lacks the new method.
