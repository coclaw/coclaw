---
'@coclaw/ui': minor
---

feat(ui): add a reveal/hide toggle to password fields

Introduce a reusable `PasswordInput` component that wraps Nuxt UI's `UInput`
with an eye button in its trailing slot, toggling the field between masked
(`password`) and plaintext (`text`). The button is `type="button"` (never
submits the surrounding form), carries a translated `aria-label` and
`aria-pressed`, and switches its icon (eye / eye-off) with the state. Fields
start masked, and the component-controlled type cannot be overridden by a
caller-passed `type` attribute.

It replaces the raw `<UInput type="password">` at all six password fields:
login, register (password + confirm), and the change-password dialog
(current / new / confirm). All forwarded attributes (`data-testid`,
`autocomplete`, `placeholder`, `class`, …) still reach the underlying input,
so existing selectors and password-manager hints are unchanged. New
`common.showPassword` / `common.hidePassword` keys are added across all 12
locales. The add-provider API-key field is intentionally left untouched (it
stays CSS-masked, not a togglable password).

Also removes the dead `AuthPrototypePage.vue` (never routed, no imports) and
its `authPrototype` i18n block across all 12 locales.
