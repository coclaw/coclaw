---
"@coclaw/openclaw-coclaw": patch
---

Restore the optional `openclaw` peerDependency so the plugin's `import('openclaw/plugin-sdk/*')` calls resolve under OpenClaw 2026.5.28's native plugin loader.

OpenClaw 2026.5.28 began native-loading built `.js` plugin entries via Node `require(esm)`, which bypasses the jiti alias the plugin previously relied on; its replacement ESM resolver hook (`Module.registerHooks`) needs Node ≥ 23.4, so on Node 22 the lazy `import('openclaw/plugin-sdk/*')` calls failed with "Cannot find package 'openclaw'", breaking the model-config RPCs (`providerAuth.list` / `model.list` / `providerAuth.catalog` / `model.listAvailable`). Declaring `openclaw` as an optional peerDependency makes `openclaw plugins install` create the `node_modules/openclaw → host openclaw` symlink (host SDK only, scrubbed of peers and installed with `--omit=peer`, so no openclaw transitive deps land in the user's environment).
