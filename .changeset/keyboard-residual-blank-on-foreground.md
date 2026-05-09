---
"@coclaw/ui": patch
---

Fix residual blank keyboard area on Android/HarmonyOS after returning from background (#243). `setupKeyboard` now subscribes to `keyboardDidHide` to clear the saved focused-input reference, and `setupAppStateChange` proactively calls `Keyboard.hide()` when the app returns to the foreground so the WebView viewport is restored even if the OS leaves stale keyboard padding.
