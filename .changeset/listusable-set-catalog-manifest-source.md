---
"@coclaw/openclaw-coclaw": patch
---

Switch the model picker's catalog source to the manifest-merged catalog so
OAuth-authorized but manifest-only providers (e.g. ChatGPT via `openai-codex`)
list their models again

`coclaw.model.listUsable` (enumeration) and `coclaw.model.set` (existence check)
both read the catalog via `loadModelCatalog({ readOnly: true })`, which only reads
the persisted `models.json`. Manifest-only providers never land on disk:
`openai-codex/*` (the 8 GPT-5.x models that a ChatGPT subscription lights up via
OAuth) are absent — the persisted file holds only an empty `openai-codex` node and
a `codex` stand-in. So even though the credential gate already recognized the
provider (`isProviderApiKeyConfigured('openai-codex')` is true), the catalog had
zero entries for it and the picker showed nothing.

Both call sites now use `loadModelCatalog({ readOnly: false })`, the same function
with manifest merging, which brings in `openai-codex/*` (and drops the `codex`
stand-in). The credential gate is unchanged: providers without any credential are
still filtered out (`loadModelCatalog` performs no ghost injection at any
`readOnly` value — ghosts only exist in the separate `buildModelsProviderData`),
so the full manifest combined with the gate is not over-permissive. Keeping both
the enumeration and the set existence check on the same source preserves the
"selectable ⇒ settable" invariant. `readOnly: false` triggers a discovery rebuild
(~10s cold, but a live gateway keeps the cache warm, ~1.2s in practice; the
fingerprint stays unchanged so nothing is rewritten).
