---
'@coclaw/openclaw-coclaw': patch
---

Add `activation.onStartup: true` to the plugin manifest so the gateway includes us in its startup plan. New OpenClaw versions filter the startup plugin set to those that declare an explicit activation path (`onStartup`, manifest channels matching configured channels, `onConfigPaths`, memory/agent-harness binding, etc.). Since CoClaw bindings are stored externally and the manifest no longer declares channels (commit b7afd1e), our plugin matched none of these paths and was silently skipped — `register()` was never invoked, so neither the realtime bridge nor any `coclaw.*` gateway method came up.
