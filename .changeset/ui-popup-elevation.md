---
'@coclaw/ui': patch
---

style(ui): lift popup menus and non-fullscreen dialogs off the background

@nuxt/ui's popovers, selects and modals ship with `shadow-lg` + a faint
`ring-default`, but in dark mode the black shadow is all but invisible and
the low-contrast ring lets the panels blend into the backdrop. Borrowing
the Quasar treatment already used by the chat scroll-to-bottom button,
apply a global elevation recipe (no per-dialog overrides):

- **Popup menus** (`UPopover`, `USelect`, via `vite.config.js`) and
  **non-fullscreen dialogs** (`UModal`, via `constants/modal-theme.js`)
  get Quasar-style multi-layer Material shadows in light mode — `shadow-2`
  for menus, one tier higher (`shadow-4`) for dialogs — replacing the flat
  `shadow-lg`. The recipe lives in `constants/popup-elevation.js`.
- In dark mode the black shadow is invisible, so a soft white glow
  (`dark:shadow-[…rgba(255,255,255,0.10)]`, same technique as the chat
  scroll-to-bottom button) plus a faint `dark:ring-white/10` edge do the
  separating. Tuned softer than the button (0.10 / ring-10 vs 0.14 /
  ring-15) to match Quasar's understated diffuse halo, since a full-size
  panel's perimeter reads heavier than a small button's. Light-mode
  sizing, rounding and the default ring are untouched (base-slot
  concatenation; the fullscreen-content red line is preserved).
- The modal overlay keeps Nuxt UI's default dimming — the glow already
  separates dialogs from the background, so no extra darkening is applied.
- The desktop sidebar's user menu drops its bespoke `bg-elevated` panel
  background so it inherits the same `bg-default` + glow as every other
  popup menu (the old elevated, square-cornered inner fought the global
  ring/glow in dark mode).

Also rides along in `vite.config.js` (a separate input-field tweak that
shares the file): a global text-input baseline on every size variant —
`text-base` locks the font at 1rem to stop iOS focus auto-zoom, `leading-normal`
loosens the too-tight built-in line height that clipped tall glyphs, and
`py-2` gives the field a touch more vertical room.
