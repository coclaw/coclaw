---
"@coclaw/ui": patch
---

Hide the redundant sidebar logo/name on the Windows desktop app. The native Windows titlebar already shows the app icon + name, so the brand row is gated off only on Windows-Electron; it stays on macOS-Electron (which hides its titlebar text), Linux-Electron, and all browsers.
