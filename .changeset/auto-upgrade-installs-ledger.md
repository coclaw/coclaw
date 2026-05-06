---
'@coclaw/openclaw-coclaw': patch
---

Fix auto-upgrade detection on OpenClaw 2026.4.25+ hosts. The host now strips
`plugins.installs` from `loadConfig()` and persists the source-of-truth in a
managed ledger at `<state-dir>/plugins/installs.json`, so the previous
`loadConfig().plugins.installs[pluginId]` lookup always saw `undefined` —
`shouldSkipAutoUpgrade` returned `true` on every check and the scheduler never
spawned the upgrade worker. The plugin now reads the install record from the
new ledger first and only falls back to the legacy `plugins.installs` field
when the ledger file is absent (ENOENT), keeping compatibility with hosts
≤ 2026.4.24. Read-side errors other than ENOENT (permissions / corrupt JSON /
missing pluginId) are treated as "no install info" rather than falling back,
to avoid misclassifying a freshly-migrated host. These error paths now emit
`remoteLog` diagnostics (`upgrade.ledger-read-failed`,
`upgrade.ledger-parse-failed`, `upgrade.state-dir-failed`) so a corrupted or
unreadable ledger surfaces a triageable signal instead of a silent
"Skipping: not an npm-installed plugin" message.
