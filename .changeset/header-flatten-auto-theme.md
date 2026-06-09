---
"@coclaw/ui": patch
---

Flatten the three desktop content headers (chat, file manager, model config) to share the page body background while keeping the hairline bottom border, so they no longer read as a sunken chrome panel on wide screens. Also make the `auto` theme follow the OS light/dark setting live: a single boot-time `matchMedia` listener now re-applies the theme when the system switches, so `.dark`, the `theme-color` meta, and the native status bar style stay in sync without needing a settings change.
