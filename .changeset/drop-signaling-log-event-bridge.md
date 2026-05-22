---
'@coclaw/ui': patch
---

Drop legacy `'log'` event bridge between `signaling-connection` and `remote-log`. The signaling module now calls `remoteLog(text)` directly; `remote-log` no longer imports `signaling-connection`. The reverse-subscription was a leftover from the era when `remote-log` sent over the signaling WS — since `remote-log` migrated to an independent HTTP POST channel, the bridge is no longer necessary. Dependencies are now strictly one-way (`signaling-connection` → `remote-log`). The `remoteLog()` helper also gains an internal try/catch fallback so log-channel failures cannot bleed back into the callers, matching the per-listener try/catch tolerance the old event bus had.
