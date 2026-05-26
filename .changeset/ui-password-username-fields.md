---
'@coclaw/ui': patch
---

fix(ui): add username field to change-password form + guard its double-submit

Follow-up to the password-form wrapping shipped in 0.26.0:

- **Username field (change-password only)**: the change-password `<form>` now
  carries a hidden `autocomplete="username"` input set to the current account's
  login name, clearing Chrome's "Password forms should have (optionally hidden)
  username fields" DOM warning and letting password managers associate the new
  password with the account. The add-provider API-key form deliberately does
  NOT get one: an API key is a secret, not a login credential, so it keeps
  `autocomplete="off"` to stay out of the password manager (the mainstream
  approach); the resulting console hint on that form is harmless and accepted.
- **Change-password submit**: add an in-flight guard and disable the footer
  buttons while the request runs, so Enter-then-click can no longer fire the
  password change twice (mirrors the add-provider dialog).
