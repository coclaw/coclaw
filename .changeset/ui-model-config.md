---
'@coclaw/ui': minor
---

feat(ui): per-claw model configuration

Add a "model settings" feature so users can make a freshly-bound claw
usable: configure LLM provider API keys and pick a default primary
model, all from the UI. This is the core first-run step — after binding
a claw you must configure a key before you can chat.

- **Entry**: a gear icon on each `ManageClawsPage` claw card (aligned
  with the existing rename pencil), plus a three-state guidance bar on
  the card that walks the user through onboarding (no API key → no
  primary model → primary invalid, mutually exclusive by priority). The
  bar is suppressed when the per-claw dashboard fetch failed, so a
  transient RPC error never surfaces a false "no key" warning. The chat
  button is never disabled — users can always enter; the plugin reports
  the error on send.
- **Subpage** (`/claws/:clawId/models`): a default-primary-model section
  and an API-credentials section. Mobile-first (bottom-sheet dialogs),
  with a desktop header + centered modals.
- **Flows**: add a provider via a single stepper dialog (pick provider →
  enter key), pick/switch the primary model (click-to-save, no second
  confirm), and remove a provider (with a strong-warning variant when it
  carries the current primary; the primary is intentionally left to be
  re-picked via the "invalid" guidance bar rather than auto-cleared).
- **Data**: `dashboard.store` gains `hasAnyProviderAuth` / `primaryModel`
  / `primaryEffective` derived per claw, fed by two new RPCs
  (`coclaw.providerAuth.list`, `coclaw.model.list`) in the existing
  parallel fetch; the subpage self-fetches its detail and force-reloads
  the store after every write so the outer card stays coherent.
- **Security**: raw API keys never reach logs, error messages, thrown
  exceptions, or any UI cache — the input is cleared synchronously before
  the RPC await, and only the plugin-side masked `keyPreview` is ever
  displayed.
- **i18n**: new `modelConfig.*` namespace added across all 12 locales.

Consumes the already-merged plugin RPC contract
(`plugins/openclaw/docs/model-config-api.md`). Out of scope this release:
OAuth login, per-agent overrides, fallback chains, key liveness probing,
model aliases, and multi-profile.

Tests: unit coverage for the helpers, store fields/derivation, error-code
mapping, guidance precedence, and every dialog/row; a 4-scenario E2E
suite (onboarding, primary-carrier removal, model switch, desktop
back-button) mocked at the `ClawConnection.request` boundary.
