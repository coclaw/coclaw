---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin): silence `coclaw.agent.abort` info log on `abort-threw`

The `coclaw.agent.abort` handler already skipped the per-call info
log for `reason=not-found` because the UI retries at 500ms while a
session is in the registration gap. `abort-threw` (raised when the
upstream `handle.abort()` keeps throwing — e.g. corrupted internal
state) goes through the same UI retry path and therefore needs the
same log gating; otherwise gateway logs flood with `[coclaw.agent.abort]
result … reason=abort-threw error=…` on every tick. `abort-threw` is
now added to the silent list alongside `not-found`. The respond
payload still carries `reason=abort-threw`, so UI behavior is
unchanged.
