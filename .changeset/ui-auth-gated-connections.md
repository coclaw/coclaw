---
'@coclaw/ui': patch
---

fix(ui): gate signaling WS and claw-status SSE by login state to stop connections when logged out.

Previously `AuthedLayout` started the signaling WS and the claw-status SSE unconditionally on mount. Combined with the `/about` route being nested under `AuthedLayout` (while marked `requiresAuth: false`), this caused two issues:

- Unauthenticated users visiting `/about` directly would immediately open a WS + SSE to the server.
- After logout, the app navigates to `/about`; since `AuthedLayout` stays mounted, the SSE never stopped and kept pushing snapshots that in turn re-triggered `claws.store` side effects.

`AuthedLayout.setup` now drives both connections from `authStore.user?.id`: connect + start when a user id is present, disconnect + stop when it becomes null. `useClawStatusSse` gained an `{ autoStart: false }` option and its `stop()` is no longer a one-shot lock — the composable can be re-`start()`ed across login/logout cycles. Window listeners (`app:foreground`, `network:online`) move in and out of scope with `start`/`stop` so post-stop events can no longer resurrect the SSE.

As a related cleanup, `auth.store.logout()` now clears the `remote-log` buffer (new exported `clearRemoteLogBuffer`) so unsent diagnostics from the previous user are not flushed onto the next user's signaling WS after re-login — previously this was a latent issue covered by a TODO; the new login/logout flow makes the reconnect path reliably trigger flush, so the fix is needed here.
