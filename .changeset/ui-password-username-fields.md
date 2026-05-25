---
'@coclaw/ui': patch
---

fix(ui): add username fields to password forms + guard change-password double-submit

Follow-up to the password-form wrapping shipped in 0.26.0:

- **Username field**: both password `<form>`s now carry a hidden
  `autocomplete="username"` input, clearing Chrome's "Password forms should
  have (optionally hidden) username fields" DOM warning. The change-password
  form uses the current account's login name (so password managers can
  associate the new password with the account); the add-provider form uses
  the provider id.
- **Change-password submit**: add an in-flight guard and disable the footer
  buttons while the request runs, so Enter-then-click can no longer fire the
  password change twice (mirrors the add-provider dialog).
