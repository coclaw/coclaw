---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin): expose awaitPluginInit so callers can drain register's fire-and-forget init

`plugin.register()` in full mode kicks off topic and chat-history load +
reconcile as fire-and-forget promises with no done signal. Tests that share a
sessions directory cannot wait for these tasks before `fs.rm`, causing
intermittent ENOTEMPTY when `reconcileAll`'s `atomicWriteJsonFile` lands during
the `rmdir` step.

Bundle both init promises into a module-level signal and export
`awaitPluginInit()`. Production gateway behaviour is unchanged (the gateway
does not call it); tests and future stop-and-restart flows can now drain
register's pending background work cleanly.
