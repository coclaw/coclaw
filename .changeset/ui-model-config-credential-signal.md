---
'@coclaw/ui': minor
---

fix(ui): drive model-config guidance from the plugin's credential signals

The `/claws` dashboard and the model-config subpage used to decide "has any API
key" / "is the primary model usable" by only counting CoClaw's own
auth-profiles store. Users who put their provider key directly in the OpenClaw
config (inline `models.providers.<id>.apiKey`) were therefore falsely flagged
"no API key, can't chat" (on-the-record production false positive).

Both now consume the new credential signals from `coclaw.model.list`:

- `noKey` is driven by the top-level `hasAnyUsableCredential`.
- the dashboard's `invalid` is driven by `default.providerUsable` — credentials
  only, the dashboard no longer pulls the full catalog to judge validity.
- a single feature-detect flag (`typeof hasAnyUsableCredential === 'boolean'`)
  gates both consumers: old plugins omit the field, so the no-key / invalid
  banners are suppressed (no-primary still shows). Prefer fewer prompts over
  false positives.
- orange-bar visibility is decoupled from catalog fetch success, so a
  `models.list` failure no longer suppresses banners that should show. The
  view:all catalog is now fetched only for agent-card labels.

The subpage keeps the bare catalog comparison for "model delisted"
(`effective = providerUsable && catalog match`). Also fixes a subpage
false-positive where a failed write-time refresh could keep a stale `invalid`
warning visible.
