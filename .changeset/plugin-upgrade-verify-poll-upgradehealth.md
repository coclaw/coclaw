---
"@coclaw/openclaw-coclaw": patch
---

Harden upgrade worker's post-restart verification. Replace the `openclaw gateway status` polling plus `openclaw plugins list` stdout substring match with a single poll loop on the `coclaw.upgradeHealth` RPC, requiring the returned version to strictly equal `toVersion`. The old check could falsely report success when `plugins update` silently no-op'd (upgradeHealth returned an old version that still satisfied the truthy-only check) and could falsely fail when the CLI table wrapped the plugin id across lines. Poll window extended to 5 minutes to accommodate cold-start delays (AWS probes, ollama detection, plugin bootstrap). On-disk `package.json` version is read for diagnostic logging only and does not gate the decision.
