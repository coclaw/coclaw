---
"@coclaw/ui": patch
---

fix(ui): override navigator.onLine in signaling __doConnect when Capacitor reports online

Android WebView occasionally reports `navigator.onLine === false` even when the
device is connected. The signaling layer used to silently pause every recovery
path in that case, leaving `sig.state` stuck at `disconnected` until the OS flag
flipped back. Track a sticky `__nativeOnline` flag set whenever the
`@capacitor/network` bridge fires `network:online`, and let it override the
`navigator.onLine === false` gate so genuine connectivity is no longer masked
by an OS-side false negative. Reset on `disconnect()` for clean session
boundaries.
