---
'@coclaw/ui': patch
---

fix(ui): unify dialog modal chrome + polish model-config layout

Consolidate the per-dialog modal padding/safe-area overrides that had
drifted apart into a single global modal theme, and tidy the
model-config page/dialog spacing. Refines the still-unreleased per-claw
model configuration feature and tightens dialog chrome app-wide.

- **Global modal theme** (`constants/modal-theme.js`, injected via
  `vite.config.js`): compact 52px header (was 64px) with an inline close
  button, two-tier responsive horizontal padding, and fullscreen
  safe-area handling that auto-targets the bottom-most slot — footer when
  present, otherwise the body (`:last-child` guarded). Uses
  `max(floor, env-inset)` so desktop/non-fullscreen degrade to the plain
  floor with no side effects. Applies to every `UModal`, so the
  web-agent picker and user settings/profile dialogs inherit the same
  chrome and drop their bespoke per-dialog overrides.
- **Dialog cleanup**: removed the footers from the primary-model picker
  and add-provider dialogs (pick-to-save / inline full-width submit;
  dismiss via close button / overlay / Esc, with the in-flight-save guard
  intact). Removed the now-redundant per-dialog `modalUi`/`safeAreaUi`.
- **Model-config page**: aligned action-button size/variant and section
  padding with `ManageClawsPage`; the credential-row revoke button now
  matches the claw unbind button.
- **Primary-model change**: dropped the success toast (the model region
  updates immediately, so the result is self-evident); the error toast on
  failure is kept.
- **Model picker dialogs**: in fullscreen the provider/model list now
  grows to fill the screen height (was capped at `60vh`, leaving dead
  space below) and the body scrollbar is hidden (reuses the main-list
  `.scrollbar-hide` pattern); desktop/non-fullscreen layout is unchanged.
  List rows now use a `min-h-10` floor with `py-2` instead of a fixed
  `h-11`: as flex children of the scroll container the fixed height was
  shrinkable and silently collapsed once the list overflowed, whereas
  `min-height` is a hard floor and also lets rows grow with the font on
  zoom / large-text. The provider-id text gained `truncate` so a long id
  ellipsizes instead of squeezing the provider name.
- **Input baseline**: a global input theme now standardizes inputs to a
  16px font, 1.5 line-height and `py-2`, and keeps the font-size at 16px
  across all breakpoints by overriding Nuxt UI's built-in shrink to 14px
  at `md` and up (re-asserting `md:text-base` through compound variants).
  That width-based shrink leaks the iOS focus-zoom trap on landscape
  iPhone / iPad (still iOS Safari, where a sub-16px input font auto-zooms
  the page on focus). Removed the now-redundant per-instance
  `leading-normal` overrides on the admin search inputs.
- **Modal close button**: widened the header close-icon negative-margin
  compensation to `-me-2.5`.
