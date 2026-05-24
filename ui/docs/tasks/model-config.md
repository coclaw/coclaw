# model-config UI implementation

Status: active
Design: ui/docs/model-config.md
Plugin contract: plugins/openclaw/docs/model-config-api.md

## Worker workflow (every subtask)

Each worker who picks up a subtask MUST:

1. Read this task file + the design doc (`ui/docs/model-config.md`) + plugin RPC contract (`plugins/openclaw/docs/model-config-api.md`).
2. Implement the subtask.
3. Run `pnpm check` then `pnpm test` from `ui/`. Local-green is mandatory before review.
4. **Invoke the `deep-review` skill** — hard gate; deep-review will auto-commit on pass.
5. Append `- T<id> done @ <commit-sha>` to the Changelog section below.
6. Mark the corresponding team task `completed`.
7. Send a one-line completion message to `team-lead` and exit.

## Hard constraints (worker MUST observe; deep-review will block on violations)

- pnpm only — no npm/yarn.
- JavaScript + jsdoc, **NOT** TypeScript.
- Vue Options API, **no** `<script setup>`.
- TAB indent.
- Top-level/named functions use `function` declarations; inline callbacks use arrows; class privates use `__xxx` prefix (not `#`).
- Unit tests: Node `node:test` style — `test()` not `it()`. Colocate as `[filename].test.js`.
- Coverage thresholds (per ui workspace `vitest` config): branches ≥ 90 %, statements/functions/lines ≥ 95 %.
- i18n: **all 12 locale files** in `src/i18n/locales/` must be updated in sync — en, zh-CN, zh-TW, es, de, fr, hi, ja, ko, pt, ru, vi. Current state shows full parity (489 lines each); CLAUDE.md mandates "all language files". Adding a key to only some files will fail deep-review.
- Brand display names (provider `displayName`) do NOT go into i18n.
- Commit message: English, imperative, scoped (e.g. `feat(ui):` / `fix(ui):` / `test(ui):` / `docs(ui):`). Every commit MUST include a `task: model-config, T<N>` line so the changelog can be reconciled.
- Each commit must pass `pnpm check` and `pnpm test` before being made.
- **API keys MUST NEVER appear in `console.log`, error messages, exception stacks, or any UI cache.** Only the plugin-side `keyPreview` (head-4 + … + tail-4) is allowed to surface.
- Mobile-first: design every layout for mobile, scale up to desktop.

## Subtasks

### [ ] T1 — Foundation: helpers, constants, store fields, route stub, i18n scaffolding

**Scope (in)**:
- New `src/utils/nav-back.js` helper extracting the 4-line `back() + fallback` pattern from `MobilePageHeader.vue`, with a configurable fallback route.
- Refactor `src/components/MobilePageHeader.vue` to delegate to the new helper (no behavior change).
- New `src/constants/provider-meta.js` with `PROVIDER_META` map and the 7 popular providers from design § 8.1 (anthropic, openai, google, groq, deepseek, moonshot, zhipuai). Each entry: `displayName`, `popular`, optional `dashboardUrl`. Export a `getProviderMeta(id)` helper that returns `{ displayName: id, popular: false }` for unknown ids.
- Extend `src/stores/dashboard.store.js`:
  - Add three derived state fields per claw: `hasAnyProviderAuth: boolean`, `primaryModel: string | null`, `primaryEffective: boolean`.
  - Add two RPC calls to the existing `allSettled` parallel fetch fan-out in `loadDashboard`: `coclaw.providerAuth.list` and `coclaw.model.list`.
  - Compute `primaryEffective` by intersecting `primaryModel` (split on `/` into provider+model) against the already-fetched `models.list view:"all"` catalog and the providers list from `providerAuth.list`.
  - On any single-RPC failure use defaults `false / null / false`; do NOT propagate to UI as warning (per design § 7.2).
  - Add a "primary-effective" pure utility function (small, exported, tested): `(primary, providers, catalog) => boolean`.
- Add the new route in `src/router/index.js` under `AuthedLayout`: `path: 'claws/:clawId/models'`, `name: 'model-config'`, `meta: { hideMobileNav: true, requiresAuth: true }`, lazy-loading `ModelConfigPage.vue`.
- New `src/views/ModelConfigPage.vue` **stub**: renders `MobilePageHeader` on mobile + a desktop header skeleton, with a "TBD" body. Receives `clawId` from `$route.params`. The page must build and navigate to without errors so T2 can iterate on it.
- New i18n namespace `modelConfig.*` with at minimum: `modelConfig.title` (= "Model settings"), `modelConfig.common.clawOffline`, `modelConfig.common.saveFailed`, `modelConfig.common.connError`, `modelConfig.common.errInvalidArgs`, `modelConfig.common.errIoFailed`. Subsequent subtasks add more keys; T1 only seeds the namespace + common bucket. All 12 locales updated.

**Scope (out)**: All component content for the subpage body (T2), all dialogs (T2/T3), ManageClaws integration & sidebar (T4), E2E (T5).

**Files to touch**:
- new `ui/src/utils/nav-back.js` + `ui/src/utils/nav-back.test.js`
- edit `ui/src/components/MobilePageHeader.vue`
- (existing `ui/src/components/MobilePageHeader.test.js` may need adjustment)
- new `ui/src/constants/provider-meta.js` + `ui/src/constants/provider-meta.test.js`
- edit `ui/src/stores/dashboard.store.js` + `ui/src/stores/dashboard.store.test.js`
- edit `ui/src/router/index.js`
- new `ui/src/views/ModelConfigPage.vue` (stub)
- edit all 12 files under `ui/src/i18n/locales/`

**Acceptance criteria**:
- Navigating to `/claws/<some-clawId>/models` renders the stub page without router or runtime errors.
- `MobilePageHeader` back behavior is unchanged (existing tests still green).
- `dashboardStore.loadDashboard(clawId)` populates the three new fields under all of: both RPCs succeed, one fails, both fail. Defaults applied on failure.
- `primaryEffective` returns `true` only when `primaryModel` parses to `provider/model` AND provider is in the auth list AND model is in the catalog under that provider.
- `provider-meta.js` test asserts shape (each popular entry has `displayName`, `dashboardUrl`) and that `getProviderMeta('unknown')` returns the documented fallback.
- All 12 locale files compile and contain the seeded `modelConfig.common.*` keys.
- `pnpm check` green; `pnpm test` green with coverage thresholds satisfied for the new files.

**Tests owned by this subtask**: `nav-back.test.js`, `provider-meta.test.js`, dashboard store tests for the new fields + RPC failure paths + the `primaryEffective` helper.

**BlockedBy**: none

---

### [ ] T2 — Subpage UI shell + provider auth list + remove flow

**Scope (in)**:
- Replace the `ModelConfigPage.vue` stub with the real layout per design § 4 + § 9:
  - Mobile: `MobilePageHeader` with title `{claw name} · 模型设置` (use `dashboardStore.instance(clawId)?.name`; fall back to `clawId`).
  - Desktop: in-page `<header class="hidden md:flex ...">` with a left back button (uses `nav-back` helper with fallback `'/claws'`) and the same title.
  - Mobile/desktop content widths per design § 9 table (desktop `max-w-2xl` centered).
  - Two sections: A. default primary model area (display-only in T2; "未配主模型" warning shows when `primaryModel` is null; "失效" warning when not effective; "Change" / "Select primary" buttons present but wired to **stubs** that just log — they get real handlers in T3).
  - B. API credentials area: list `profiles` from `providerAuth.list`, each rendered as a `ProviderAuthRow`; empty state per design § 4.B; `[+ Add]` button present but wired to a stub.
  - Offline state: when `dashboardStore` reports claw offline, render the "claw offline" message and disable all action buttons.
  - On mount: fetch `coclaw.providerAuth.list` + `coclaw.model.list` + `models.list view:"all"` via component state (per design § 7.3 — NOT through dashboard.store). Loading + error states.
- New `src/components/model-config/ProviderAuthRow.vue`:
  - Props: `profile` (the list entry: `{ profileId, provider, type, keyPreview, ... }`).
  - Renders display name (from `provider-meta`), `keyPreview`, and a "Remove" button.
  - Emits `remove` event with the provider id.
  - For `type === 'oauth'` profiles: render read-only (no remove button) per design (OAuth not in scope this release).
- New `src/components/model-config/RemoveProviderConfirmDialog.vue`:
  - Props: `provider` (id), `isPrimaryCarrier` (boolean), `open` (v-model:open).
  - Renders the two text variants from design § 5.4 (normal vs. strong-warning).
  - Emits `confirm` and `cancel`.
- Wire end-to-end remove path: click "Remove" on a row → open confirm dialog with `isPrimaryCarrier` derived from current `default.primary` vs. row's provider → on confirm call `coclaw.providerAuth.remove({ provider })` → on success: refresh component-state `profiles` + call `dashboardStore.loadDashboard(clawId, { force: true })` + notify success → on error: notify per error-code map. **Do not** clear `primary` automatically (per design § 5.4).
- Use the global `useNotify()` composable (per `ui-notify` skill) for all success/failure feedback — no inline status text.
- Add i18n keys this subtask needs under `modelConfig.primary.*` and `modelConfig.providerAuth.*` per design § 8.2 (e.g. `primary.title`, `primary.notSetWarning`, `primary.invalidWarning`, `primary.changeButton`, `primary.selectButton`, `providerAuth.title`, `providerAuth.addButton`, `providerAuth.removeButton`, `providerAuth.emptyState`, `providerAuth.remove.title`, `providerAuth.remove.descNormal`, `providerAuth.remove.descAffectPrimary`, `providerAuth.remove.confirmButton`). All 12 locales.

**Scope (out)**: Add-provider stepper dialog (T3), primary model picker dialog (T3), ManageClaws gear icon & guidance (T4), sidebar prefix-match (T4), E2E (T5).

**Files to touch**:
- edit `ui/src/views/ModelConfigPage.vue` + new `ModelConfigPage.test.js`
- new `ui/src/components/model-config/ProviderAuthRow.vue` + test
- new `ui/src/components/model-config/RemoveProviderConfirmDialog.vue` + test
- new keys in all 12 files under `ui/src/i18n/locales/`

**Acceptance criteria**:
- Subpage renders correctly on mobile + desktop breakpoints (manual visual confirmation acceptable).
- Initial fetch races (success / partial failure / total failure) all render a sensible state — no crashes, no permanently-blank UI.
- "Remove" path: opens correct dialog variant based on whether the provider is the current primary's carrier, confirms call the RPC, on success refreshes local list + triggers `dashboardStore` reload, on failure notifies.
- `primary` is NOT cleared automatically after a remove (verify with a unit test that the dialog confirm handler does not invoke `model.set`).
- OAuth-typed profiles render read-only (no remove button), api_key-typed render with remove.
- All 12 locales contain the new keys.
- `pnpm check` green; `pnpm test` green with coverage thresholds satisfied.

**Tests owned by this subtask**: `ModelConfigPage.test.js` (render + fetch races + remove wiring), `ProviderAuthRow.test.js` (props/events/OAuth read-only), `RemoveProviderConfirmDialog.test.js` (both text variants + emits).

**BlockedBy**: T1

---

### [ ] T3 — Add-provider stepper dialog + primary model picker dialog + write flows

**Scope (in)**:
- New `src/components/model-config/AddProviderDialog.vue`:
  - **Single dialog with internal stepper** (design § 5.2 — Nuxt UI 4 stepper component; consult the `nuxt-ui` skill for current API).
  - Mobile: bottom-sheet full-screen presentation. Desktop: `UModal` centered.
  - Props: `open` (v-model:open), `providerCatalog` (list of providers derived from `models.list view:"all"`), `existingProviders` (array of provider ids already in auth list — excluded from selection).
  - Step 1: search + grouped list. Popular providers first (per `provider-meta.popular`), then "Other". Use `displayName` from `PROVIDER_META`.
  - Step 2: password-type input for the API key, `[去官网创建]` link if `dashboardUrl` exists for that provider (opens via Electron / Capacitor external opener — re-use whatever pattern already exists in the codebase; if none, fall back to `window.open`).
  - "Cancel" on either step closes the entire dialog (do NOT step back to step 1).
  - On submit: trim() the apiKey; if empty, inline INVALID_ARGS message. Call `coclaw.providerAuth.setApiKey({ provider, apiKey })`. On success: emit `added` with the new profile + close. On failure: render inline error mapped from the error code (use the `modelConfig.common.err*` keys from T1).
- New `src/components/model-config/PrimaryModelPickerDialog.vue`:
  - Mobile bottom-sheet, desktop UModal.
  - Props: `open`, `providers` (currently-bound provider ids), `catalog` (from `models.list view:"all"`), `current` (current primary string or null).
  - Renders a search input + a list grouped by provider; each group contains only models from that provider that exist in the catalog. The currently-selected item is marked.
  - On click of a row: immediately call `coclaw.model.set({ primary: '<provider>/<model>' })` (no extra confirm). On success: emit `picked` with the new primary + close. On failure: notify.
- Wire `ModelConfigPage.vue` to mount both dialogs and handle their events:
  - "[+ Add]" → open `AddProviderDialog`; on `added` → refresh local `profiles` + `dashboardStore.loadDashboard(force)` + notify.
  - "Change" / "Select primary" → open `PrimaryModelPickerDialog`; on `picked` → update local `default.primary` + `dashboardStore.loadDashboard(force)` + notify.
- New small utility for error-code → user-friendly text (e.g. `src/utils/model-config-errors.js` or co-located inside a component if simpler) + test. Must use the `modelConfig.common.err*` keys.
- Add i18n keys: `modelConfig.providerAuth.add.*` (step titles, search placeholder, key input label, "Go to dashboard" link text, submit/cancel buttons) and `modelConfig.primary.pickerTitle` + `modelConfig.primary.pickerSearchPlaceholder` + any other strings needed. All 12 locales.

**Scope (out)**: ManageClaws gear icon & guidance (T4), sidebar prefix-match (T4), E2E (T5).

**Files to touch**:
- new `ui/src/components/model-config/AddProviderDialog.vue` + test
- new `ui/src/components/model-config/PrimaryModelPickerDialog.vue` + test
- edit `ui/src/views/ModelConfigPage.vue` to mount + wire dialogs
- (maybe) new `ui/src/utils/model-config-errors.js` + test
- new keys in all 12 files under `ui/src/i18n/locales/`

**Acceptance criteria**:
- Add provider end-to-end: pick a provider → enter key → submit → success path closes dialog + refreshes list + notifies. Failure shows inline error keyed off the RPC error code. Cancel at any step closes cleanly.
- Trim leading/trailing whitespace from the key before submit; empty-after-trim renders INVALID_ARGS inline (no RPC call).
- Provider list in Step 1 excludes already-bound providers (so users don't accidentally overwrite).
- Primary model picker: clicking a row immediately calls `model.set` and emits `picked` (no extra confirm). On success notifies + closes; on failure notifies + stays open.
- Picker list shows ONLY models whose provider is currently bound (intersect `providers` with catalog).
- After any write, the dashboard store reload is triggered with `force: true`.
- `console.log` in any code path involving `apiKey` MUST not exist (worker should grep their own diff).
- All 12 locales contain the new keys.
- `pnpm check` green; `pnpm test` green with coverage thresholds satisfied.

**Tests owned by this subtask**: `AddProviderDialog.test.js` (stepper navigation + cancel semantics + submit success/failure + trim behavior + dashboard link presence/absence), `PrimaryModelPickerDialog.test.js` (search + grouping + click-to-save + intersection logic), `ModelConfigPage.test.js` extensions (wiring of add/change events to store reload), `model-config-errors.test.js` (each error code maps to the documented locale key).

**BlockedBy**: T2

---

### [ ] T4 — ManageClaws integration: gear icon + guidance bar + sidebar prefix-match

**Scope (in)**:
- Edit `src/views/ManageClawsPage.vue`:
  - Add a gear icon button (`i-lucide-settings`) next to the claw name on each card, visually aligned with the existing pencil rename icon. Only enabled when the claw is online. Clicking navigates to `/claws/<clawId>/models`.
  - Add an orange guidance bar below the claw header showing the worst-priority warning (1 > 2 > 3 per design § 6):
    1. credentials list empty → `guidance.noKeyWarning`
    2. credentials non-empty but primary null → `guidance.noPrimaryWarning`
    3. primary non-null but ineffective → `guidance.invalidPrimaryWarning`
  - Bar includes a `[Go configure]` link → `/claws/<clawId>/models`.
  - Only shown when the claw is online AND the dashboard fetch for that claw succeeded (per design § 7.2: defaults of `false/null/false` from failure must NOT render the bar). Required gating signal: track whether the relevant RPCs actually returned (e.g. derive a `providerAuthFetched: boolean` / `primaryFetched: boolean` per claw from the dashboard store, or surface the `allSettled` outcomes — worker chooses, but the gating MUST exist and be tested).
  - **chat button is NOT disabled** regardless of state (per design § 6) — explicit unit test for this invariant.
- Edit `src/components/MainList.vue`:
  - Change "我的 Claw" sidebar item active-highlight logic from exact-match (`currentPath === '/claws'`) to prefix match (`currentPath === '/claws' || currentPath.startsWith('/claws/')`). Refer to design § 3 "桌面端归属表达".
- Add i18n keys under `modelConfig.guidance.*`: `guidance.noKeyWarning`, `guidance.noPrimaryWarning`, `guidance.invalidPrimaryWarning`, `guidance.goConfigure`. All 12 locales.
- Consider a helper that picks the highest-priority guidance state (`pickGuidanceState({ hasAny, primary, effective }) => 'noKey' | 'noPrimary' | 'invalid' | null`) + test — encapsulates the precedence rule.

**Scope (out)**: E2E (T5).

**Files to touch**:
- edit `ui/src/views/ManageClawsPage.vue` + tests
- edit `ui/src/components/MainList.vue` + `MainList.test.js`
- possibly new `ui/src/utils/guidance-state.js` + test (or inline the helper in the page)
- new keys in all 12 files under `ui/src/i18n/locales/`

**Acceptance criteria**:
- Gear icon visible only when claw online; disabled state otherwise (or hidden — pick one consistent with the pencil icon's current behavior).
- Clicking gear navigates to `/claws/:clawId/models`.
- Guidance bar shows the correct text for each of the three precedence cases and disappears when none applies.
- Guidance bar does NOT show when the per-claw fetch failed (defaults present but unknown state — explicit test for this).
- Chat button remains enabled in all guidance states (explicit test).
- Sidebar `MainList` "我的 Claw" item stays highlighted on `/claws`, `/claws/add`, `/claws/:id/models`, and any other `/claws/...` path. Existing `MainList.test.js` extended.
- All 12 locales contain the new keys.
- `pnpm check` green; `pnpm test` green with coverage thresholds satisfied.

**Tests owned by this subtask**: ManageClawsPage tests for gear icon visibility + nav, guidance precedence (3 happy + 1 "unknown" suppressed), chat-button-not-disabled invariant, MainList prefix-match cases, optional `pickGuidanceState` helper test.

**BlockedBy**: T1 (needs store fields + route + provider-meta + i18n scaffolding)

---

### [ ] T5 — E2E suite (4 scenarios)

**Scope (in)**: Implement the 4 mandatory E2E scenarios from design § 11. Suite must run non-interactively from `pnpm` per the `e2e-test` skill conventions. **Load the `e2e-test` skill before writing or running these tests** (project rule).

**Scenarios**:
1. **First-time onboarding main path**: bind a claw → ManageClaws shows the orange "no API key" bar → click "Go configure" → land on model-config subpage → add an API key (mock or real test provider, per e2e-test skill conventions) → pick a primary model → back to ManageClaws → bar gone, AgentCard shows the modelLabel.
2. **Remove the provider that carries primary**: with a claw that has key + primary configured, open subpage → remove that provider → verify the strong-warning dialog text appears → confirm removal → ManageClaws bar now shows "primary invalid" (auto-flip).
3. **Switch primary model**: open subpage, pick a different model → no second confirm → toast + immediate state update on the subpage AND outer AgentCard / primary area.
4. **Desktop back button**: (a) navigate Chat → subpage → back → returns to Chat; (b) cold-start deep-link into subpage → back → goes to `/claws` (fallback).

**Files to touch**:
- new spec(s) under `ui/e2e/...` per the existing E2E directory layout (worker should inspect the existing E2E suite to follow naming and helper patterns).
- if new test fixtures or RPC mocks are needed, co-locate them per e2e-test conventions.

**Acceptance criteria**:
- All 4 scenarios pass headless in CI configuration.
- Each scenario tagged per the `e2e-test` skill's tag taxonomy (smoke / regression / etc. as appropriate).
- No flakes when re-run 3 times locally (`pnpm test:e2e <spec>` x 3).
- Suite teardown leaves no orphan claw bindings, dialogs, or open browser contexts.

**Tests owned by this subtask**: the 4 E2E scenarios above. No new unit tests expected (those were covered in T1–T4).

**BlockedBy**: T1, T2, T3, T4

---

## Changelog

<!-- workers append "- T<id> done @ <commit-sha>" after deep-review passes -->
- T1 done @ e592a36
- T2 done @ ce19032
- T3 done @ a7def6b
- T4 done @ fc08cae
- T5 done @ 5cc0dee
