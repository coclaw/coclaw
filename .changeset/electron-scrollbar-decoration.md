---
"@coclaw/ui": patch
---

Add thin translucent scrollbar decoration for Electron shell scroll containers: `scrollbar-color` is declared once on the `html.cc-electron-custom` scope root (inherited by all scroll boxes), and `scrollbar-width: thin` targets the two real page-level scrollers (`.cc-app-content` and the ChatPage message area via a `cc-scrollbar-thin` marker class). Hidden scrollbars (`scrollbar-hide`) are unaffected; web and Capacitor are unaffected.
