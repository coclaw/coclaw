---
'@coclaw/openclaw-coclaw': minor
---

Add developer-helper CLI subcommands for the provider-auth RPCs:
`openclaw coclaw auth set-api-key <provider> --key <value>` stores an API
key (optionally with `--profile-id`), `openclaw coclaw auth list
[--provider <p>]` prints stored profiles with masked previews, and
`openclaw coclaw auth remove <provider>` clears them. All three are thin
CLIs that delegate to the corresponding gateway RPCs and share the
existing retry / restart helpers used by `bind` / `unbind`.
