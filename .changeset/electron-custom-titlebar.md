---
"@coclaw/ui": minor
---

Add a custom title bar for the Electron desktop shell. The native OS title bar is hidden while the system still paints the window controls (traffic lights on macOS, the Window Controls Overlay on Windows), and the web layer takes over that strip's background and drag region — matching VS Code / Slack / Linear. All title-bar offsets live behind an `html.cc-electron-custom` scope class that web and Capacitor never receive, so their layout and CSS are byte-for-byte unchanged. The Windows control-overlay color follows the active theme (including live `auto` changes), and the strip stays clear of modals, popovers, selects, and toasts.
