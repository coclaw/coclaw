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
- **Input baseline**: a global input theme now standardizes inputs to a
  16px font, 1.5 line-height and `py-2`, and locks the font-size to 16px
  across all breakpoints via `fixed: true` — disabling Nuxt UI's built-in
  shrink to 14px at `md` and up. That width-based shrink leaks the iOS
  focus-zoom trap on landscape iPhone / iPad (still iOS Safari, where a
  sub-16px input font auto-zooms the page on focus). Removed the
  now-redundant per-instance `leading-normal` overrides on the admin
  search inputs.
- **Modal close button**: widened the header close-icon negative-margin
  compensation to `-me-2.5`.
