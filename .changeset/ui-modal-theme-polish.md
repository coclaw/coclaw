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
  List rows use a `min-h-10` floor with `py-1` instead of a fixed `h-11`:
  as flex children of the scroll container the fixed height was shrinkable
  and silently collapsed once the list overflowed, whereas `min-height` is
  a hard floor; the tighter `py-1` leaves more of the 40px floor for the
  text to grow into on zoom / large-text. Rows show the raw OpenClaw
  provider/model id directly and drop the mapped `displayName` (the
  mapping is incomplete and largely duplicates the id, and using the name
  would have to be mirrored across both dialogs — deferred to a later
  name-only pass). The picker group headings and the add-provider Step 2
  title / dashboard hint also use the raw id; search and sort still match
  the mapped name internally for now. Rows are single-line `truncate`,
  tightened to `gap-2`, and gained `cursor-pointer` (the global pointer
  cursor only covers `UButton`, not these native `<button>`s). In the
  picker the current-model check moved from the row head to the tail
  (sharing the slot with the save spinner) so the head text aligns
  vertically across rows; group headings use a uniform `pt-1`. Both search
  boxes bulge 2px past each edge via a `-mx-0.5` wrapper.
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
