---
'@coclaw/openclaw-coclaw': patch
---

Fix: `coclaw.bind` / `coclaw.unbind` / `coclaw.enroll` now reject empty-string `serverUrl`. Previously only the `typeof === 'string'` check ran; once `""` passed, `serverUrl ?? api.pluginConfig?.serverUrl` did not fall back (because `""` is not nullish), and `unbindClaw`'s `if (baseUrl)` would skip the server-side unbind and clear the local config — producing an orphan bot. The error message also changes from `serverUrl must be a string` to `serverUrl must be a non-empty string`.
