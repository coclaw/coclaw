---
"@coclaw/ui": patch
---

Stabilize the desktop list height of the add-provider and primary-model picker dialogs so the dialog no longer changes height while filtering. The fixed height now lives on each dialog's list-screen container (the picker body wrapper / the add-provider Step 1 container) with the list filling it via `flex-1` — uniform across mobile and desktop, removing the previous `flex-1`↔`flex-none` breakpoint switch. A `vh`-based max-height lets the container shrink on short viewports, so the modal body no longer overflows into a stray outer scrollbar and the dialog stays within the viewport on baseline browsers where the modal's default `dvh` cap is unsupported. The add-provider Step 2 config screen is untouched (still content-sized).
