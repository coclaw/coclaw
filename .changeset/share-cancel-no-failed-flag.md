---
"@coclaw/ui": patch
---

Stop showing a "failed" red flag in the file manager when a downloaded file's system share dialog is dismissed (#233). Capacitor Share has no structured marker that distinguishes "user cancelled" from other share-stage errors across iOS / Android / HarmonyOS / Web, so any message-string matching was a non-portable anti-pattern. `__nativeShareFile` now swallows every `Share.share` rejection (logging a single `console.warn` for diagnostics) — the file has already been written to cache and is cleaned up by `finally`, and any remaining share-stage errors are not user-actionable. Real download / cache-write failures still surface as `failed` because they happen before the `Share.share` try-block.
