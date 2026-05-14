---
'@coclaw/openclaw-coclaw': patch
---

Fix the provider-auth RPCs (`coclaw.providerAuth.setApiKey` / `list` /
`remove`) end-to-end:

- Load the plugin-sdk via a literal `import('openclaw/plugin-sdk/provider-auth')`
  in the plugin entry and pass it into the handler registrar. OpenClaw's
  plugin loader only triggers the `openclaw/plugin-sdk/*` alias rewrite when
  the bare specifier appears as a string literal in the entry file's source;
  the previous variable-based dynamic import sat in a sub-module, missed the
  loader scan, fell through to native Node resolution and failed because the
  link-stage `node_modules/` doesn't bundle `openclaw`.
- Wrap all three RPC responses in `{ status: <data> }` and emit `{ status: {} }`
  (not `undefined`) on remove. The plugin's shared `callGatewayMethod` helper
  unwraps `.status` from `openclaw gateway call --json` output, and the
  upstream CLI crashes with a `TypeError: ...endsWith` when the data payload
  is `undefined`.
- Declare `openclaw` as an optional `peerDependencies` entry per OpenClaw
  plugin development docs.
