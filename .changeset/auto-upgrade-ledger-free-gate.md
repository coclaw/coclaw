---
'@coclaw/openclaw-coclaw': patch
---

Auto-upgrade no longer reads the retired install ledger. Install source and path are now gated per cycle via `openclaw plugins inspect --json`, with a post-update outcome check that no-op skips un-advanced updates and verifies the actually installed version.
