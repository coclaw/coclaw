---
"@coclaw/ui": patch
---

Recognize user-cancelled share dialog across platforms and locales (#233). Replace the single `/cancel/i` regex in `__nativeShareFile` with an explicit keyword whitelist (`cancel`, `取消`, `キャンセル`, `dismiss`, `user declined`, `user aborted`) so HarmonyOS and other locales no longer mark a cancelled share as a failed download in the file manager. The whitelist deliberately excludes vague words like `abort`/`failed`/`error` to avoid swallowing real failures.
