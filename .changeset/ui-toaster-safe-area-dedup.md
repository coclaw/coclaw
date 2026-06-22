---
"@coclaw/ui": patch
---

Fix the desktop (Electron) toast notification position double-counting the top safe-area inset on notched Macs in fullscreen; the inset is now applied once, via the toast viewport margin.
