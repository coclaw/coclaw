---
'@coclaw/openclaw-coclaw': patch
---

Fix the provider-auth RPCs (`coclaw.providerAuth.setApiKey` / `list` /
`remove`) so the plugin-sdk import is actually picked up by OpenClaw's
plugin loader.

The SDK is now loaded via a literal `import('openclaw/plugin-sdk/provider-auth')`
in the plugin entry, and the resolved module is passed into the handler
registrar. OpenClaw's plugin loader only triggers the
`openclaw/plugin-sdk/*` alias rewrite when the bare specifier appears as a
string literal in the entry file's source. The previous variable-based
dynamic import sat in a sub-module, missed the loader scan, fell through
to native Node resolution, and failed because the link-stage
`node_modules/` doesn't bundle `openclaw`.

Note: the original `{ status: <data> }` response wrap shipped with this
commit has since been removed by the "drop coclaw status wrap" changeset;
the optional `openclaw` peerDependency declaration has since been removed
by the "drop optional openclaw peerDependency" changeset. See those
changesets for the current state of those concerns.
