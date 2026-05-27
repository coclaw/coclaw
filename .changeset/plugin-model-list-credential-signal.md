---
'@coclaw/openclaw-coclaw': minor
---

feat(openclaw): add credential signals to `coclaw.model.list` output

The dashboard's "no API key, can't chat" guidance only counted CoClaw's own
auth-profiles store, so users who configured their provider key directly in the
OpenClaw config (inline `models.providers.<id>.apiKey`) were falsely flagged as
having no key.

`coclaw.model.list` now reports credential signals alongside the existing
`{ default, agents }`:

- each scope gains `providerUsable` — whether the primary's provider has a
  usable credential, judged by OpenClaw's own `isProviderApiKeyConfigured`
  (env + auth-profiles, with alias normalization done inside it) OR an inline
  config key (`hasConfiguredSecretInput`). `null` primary → `false`.
- a new top-level `hasAnyUsableCredential` — auth-profiles store non-empty OR
  any provider node carries an inline key.

The fields are additive; old plugins simply omit `hasAnyUsableCredential`, so
the UI feature-detects and suppresses the no-key/invalid banners when the
signal is absent (prefer fewer prompts over false positives).

Scope is deliberately limited to inline keys (the on-the-record production
false positive). Env-only-without-node providers, key-less IAM/local models,
and alias-spelling mismatches remain accepted residuals — same as today, so no
regression.
