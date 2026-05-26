---
'@coclaw/ui': patch
---

fix(ui): clear change-password form on close + stop the keyboard mangling the API key

Two follow-ups to the password/secret input work in 0.26.0:

- **Change-password form clears on every close path**: cancelling, the X,
  Esc, or clicking the overlay now wipes the entered current/new/confirm
  passwords, so reopening the dialog never shows stale input and nothing
  lingers in memory. Previously only a successful submit cleared the form.
  All close paths converge on one reset; a close while the request is still
  in flight is skipped (that submit's own success path clears it) so the two
  never race.
- **API-key field no longer lets the keyboard rewrite the key**: now that the
  field is `type="text"` (CSS-masked, not a password), mobile input methods
  re-enabled auto-capitalize / auto-correct, which could uppercase or "fix" a
  hand-typed key. It now sets `autocapitalize="none"` and `autocorrect="off"`
  (alongside the existing `spellcheck="false"`), restoring what `type="password"`
  suppressed by default. It stays `type="text"` — not reverted to a password
  field, which would bring back the browser's save-password prompt.
