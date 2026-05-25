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
