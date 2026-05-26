---
'@coclaw/ui': patch
---

fix(ui): add autocomplete hints to the login form

Tag the login account field with `autocomplete="username"` and the login
password field with `autocomplete="current-password"`, the standard
HTML autofill tokens for a sign-in form. The register and change-password
forms already carried explicit autocomplete; login was the only auth form
left relying on browser heuristics. Chrome's heuristics already worked, but
weaker environments — other browsers, third-party password managers, and
especially Android WebView system autofill — depend on these explicit hints
to recognise the fields, so this improves recognition and save/associate
reliability there. No `name` attributes are added, matching the existing
CoClaw convention (autocomplete-only).
