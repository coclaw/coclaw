---
"@coclaw/ui": patch
---

Cap image-preview (ImgViewDialog) height to the dialog's available area so a tall image no longer triggers inner-scroll on short windows (notably Electron, where the overlaid title bar shrinks usable height below ~680px).
