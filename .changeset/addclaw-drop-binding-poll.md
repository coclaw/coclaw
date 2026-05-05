---
'@coclaw/ui': patch
---

Stop AddClawPage from long-polling `POST /api/v1/claws/binding-codes/wait`. The page now consumes the global `claw-status-stream` SSE channel that AuthedLayout already keeps open: it captures a baseline of current claw ids (after `clawsStore.fetched=true`, i.e. SSE has delivered at least one snapshot) and watches a scalar `newClawId` computed (avoids deep-watch on `clawsStore.byId`); the watcher fires on the first id appearing outside baseline — covering both the live `claw.bound` event and the snapshot delivered after SSE reconnect.

This fixes a 404 storm after server restart: the server keeps binding wait state in memory, so a restart wiped it and the wait endpoint started returning `404 BINDING_NOT_FOUND` for any in-flight code. The previous loop only treated `BINDING_TIMEOUT` (HTTP 408) as terminal, so a 404 fell into the catch and immediately retried with no backoff — the client spammed the endpoint at single-digit-millisecond intervals until the binding code's natural deadline.

Removed the now-unused `waitBindingCode` export from `services/claws.api.js` and the corresponding tests. The server-side `/binding-codes/wait` endpoint is left untouched for backward compatibility with older clients.

Documents the new flow in `docs/architecture/bot-binding-and-auth.md`. Logs two pre-existing follow-ups uncovered during deep review: AddClawPage has no in-flight guard for concurrent `startBinding` calls, and `captureBaseline` will block indefinitely if SSE never delivers a snapshot (only manifests when the broader app is also broken). A separate `server/TODO.md` entry tracks the SSE handler's snapshot-then-register race that can drop a `claw.bound` event in a tens-of-milliseconds window during reconnect.
