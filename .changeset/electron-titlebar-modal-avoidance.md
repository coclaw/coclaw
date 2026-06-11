---
"@coclaw/ui": patch
---

Fix Electron custom titlebar overlapping the top of tall and fullscreen modals: add geometric avoidance rules (centered modals shift down by half the titlebar height with reduced max-height; fullscreen modals offset their top edge) scoped to `html.cc-electron-custom` via a `cc-modal-content` marker class, so modal headers and close buttons stay clickable below the drag strip and OS window controls. Web and Capacitor are unaffected.
