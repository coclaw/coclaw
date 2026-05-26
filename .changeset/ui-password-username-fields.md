---
'@coclaw/ui': patch
---

fix(ui): add username field to change-password form + guard its double-submit

Follow-up to the password-form wrapping shipped in 0.26.0:

- **Username field (change-password only)**: the change-password `<form>` now
  carries a hidden `autocomplete="username"` input set to the current account's
  login name, clearing Chrome's "Password forms should have (optionally hidden)
  username fields" DOM warning and letting password managers associate the new
  password with the account.
- **API-key field — keep the password manager out**: the add-provider key
  input is no longer `type="password"`. An API key is a secret, not a login
  credential, but Chrome ignores `autocomplete="off"` on password fields and
  still offers to "save/update password" (guessing the account's login name as
  the username) when the dialog submits. The field is now a `type="text"` input
  masked purely in CSS (`-webkit-text-security: disc`), so the browser no longer
  treats it as a password — no save prompt, and the password-form DOM warnings
  disappear too. The `<form>` also carries `autocomplete="off"` as a
  belt-and-suspenders. Falls back to plaintext on Firefox < 117 (masking only;
  input/submit unaffected).
- **Change-password submit**: add an in-flight guard and disable the footer
  buttons while the request runs, so Enter-then-click can no longer fire the
  password change twice (mirrors the add-provider dialog).
