---
"@coclaw/ui": patch
---

Loosen the header top spacing of the shared lightweight prompt/confirm dialog style (`promptModalUi`) from the compact global default (`py-1 min-h-13`) to `pt-2 pb-1 min-h-14`, giving the title more breathing room from the top edge. Only dialogs using this shared style are affected; larger dialogs (settings, pickers) keep the global header.
