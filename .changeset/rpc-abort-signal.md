---
'@coclaw/ui': patch
---

Add AbortSignal support to RPC and file-transfer; extend connect timeouts to 120s to match RTC recovery window.

Previously `waitReady` / `request()` used a 30s `connectTimeout` and `READY_TIMEOUT_MS` was 15s. But the underlying RTC recovery cycle can last up to ~3 minutes (ICE restart 90s + rebuild backoff), so application-level requests could reject with `CONNECT_TIMEOUT` while RTC was still quietly recovering — the user would see a stale error toast, then everything would work again seconds later.

- `ClawConnection.request()` now accepts `options.signal` (AbortSignal). The signal covers both the `waitReady` queueing stage and the `pending` wait-for-response stage.
- `downloadFile` / `uploadFile` / `postFile` now accept `opts.signal`. The signal covers the full three-stage lifecycle (waitReady → wait for response header → chunk send/receive), aligning with the fetch/axios mental model.
- `handle.cancel()` on file transfers is kept as a backward-compatible API (internally equivalent to `controller.abort()`). Existing callers are unaffected.
- Abort reject shape aligns with axios `CanceledError`: `err.name = 'CanceledError'`, `err.code = 'ERR_CANCELED'`. Check via `err.code === 'ERR_CANCELED'`.
- `DEFAULT_CONNECT_TIMEOUT_MS`: 30s → 120s. `READY_TIMEOUT_MS`: 15s → 120s.
- Existing call sites pass no signal — this is purely infrastructure groundwork. No behavioural change for callers that don't opt in.
- Fixes a pre-existing latent bug: file-transfer `handle.cancel()` during the waitReady queueing stage used to defer the outer-promise reject until `waitReady` itself settled. Now the signal is threaded through `waitReady`, so cancel is immediate.

Internal error code migration: file-transfer's cancellation error code changed from `CANCELLED` to `ERR_CANCELED`. Two call-site checks (`files.store.js`, `chat.store.js`) were updated in lockstep. No i18n changes required — the chat-store cancellation path early-returns before hitting UI notify.
