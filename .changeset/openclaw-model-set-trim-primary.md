---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin/model-default): trim primary in `coclaw.model.set`

`coclaw.model.set` now trims the `primary` parameter before validation,
so a copy-pasted value with leading/trailing whitespace (e.g.
`'openai-codex/gpt-5.5 '`) is accepted and stored without the
whitespace, instead of failing the catalog lookup with a misleading
`model "openai-codex/gpt-5.5 " not found in catalog` message. A primary
that becomes empty after trimming still reports the existing
"non-empty string or null" `INVALID_ARGS`.
