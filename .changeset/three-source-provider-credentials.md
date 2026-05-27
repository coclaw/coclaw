---
"@coclaw/openclaw-coclaw": minor
"@coclaw/ui": minor
---

List and revoke provider credentials across all three sources

The API-keys screen now lists credentials from all three sources — CoClaw's own
store, inline keys written in `openclaw.json`, and host environment variables —
instead of only the managed store. This fixes the contradiction where a model
worked fine yet the list claimed no key was configured.

- `coclaw.providerAuth.list` returns a `source` (`profile` | `inline` | `env`)
  and `removable` flag per credential (additive; old clients ignore them).
- `coclaw.providerAuth.remove` takes an optional `source` and dispatches
  accordingly: the managed store deletes the credential, an inline key deletes
  only the `apiKey` field (keeping the rest of the provider node), and env keys
  are read-only.
- UI: each row shows a source tag; env rows are read-only with a hint to remove
  on the OpenClaw host; revoking an inline key warns it edits the config file;
  the model picker and add-provider list now account for inline/env providers.
