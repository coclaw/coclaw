---
'@coclaw/ui': patch
---

fix(ui): wrap change-password fields in a form to clear DOM warning

The change-password dialog's current/new/confirm password inputs were not
contained in a `<form>`, so Chrome logged a "Password field is not contained
in a form" DOM warning and password managers couldn't reason about the fields.
Wrap the three inputs in a `<form>` (submit handled, Enter still submits via a
hidden submit button) and add `autocomplete` hints (`current-password` /
`new-password`), matching the add-provider dialog's existing fix.
