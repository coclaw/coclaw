---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin/auto-upgrade): emit diagnostic signal when legacy install-record read fails

`loadInstallRecordFromLegacyConfig` (the pre-2026.4.25 fallback path
that reads `plugins.installs` from `openclaw.json`) silently swallowed
exceptions and returned `null`. The three sibling catch blocks in
`loadInstallRecord` already pushed `upgrade.state-dir-failed`,
`upgrade.ledger-read-failed`, and `upgrade.ledger-parse-failed` via
`remoteLog`; this one was the only blind spot.

Downstream this meant `start()` would log the generic
"Skipping: not an npm-installed plugin" with no way to tell whether the
plugin truly was not registered or the host config reader had thrown.
The catch now pushes `upgrade.legacy-config-read-failed msg=...` to
match the existing diagnostic style.
