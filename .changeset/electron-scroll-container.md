---
"@coclaw/ui": patch
---

Declare `color-scheme` following the light/dark theme so browser-native UI (scrollbars, form controls, autofill) renders dark in dark mode, and move Electron in-app scrolling from the document into the content container below the custom titlebar — scrollbars no longer span the titlebar (on Windows the scrollbar's top arrow was covered by window controls), and sticky elements naturally anchor below the titlebar.
