---
'@coclaw/ui': patch
---

fix(ui): make logout idempotent and serialize auth actions against it

Third pass on logout. Two related gaps:

1. **401-during-logout double-cleanup.** When the POST `/logout` API itself returns 401 (common when the session has already expired), `http.js` synchronously dispatches `auth:session-expired`. `AuthedLayout.__onSessionExpired` saw `authStore.user` still populated (the first `logout()` had not yet written `user = null`) and called `authStore.logout()` a second time. Two cleanup chains then ran in parallel — `$reset`, `disconnectAll`, timer clears all invoked twice, and two competing `router.replace` calls landed on different targets.
2. **No guarantee that a new login starts in a clean environment.** While existing call sites all `await authStore.logout()` before navigating, the invariant was not enforced at the store level. Any future trigger that forgot to `await` would race resource cleanup against a concurrent login.

Fix: add a module-level `__logoutInflight` Promise lock in `auth.store.js`.

- `logout()` is now idempotent: reentrant calls return the same in-flight Promise; the API call, the 20-step cleanup chain, and `router.replace` side-effects each run exactly once. The cleanup body is now an IIFE inside the `logout` action (not a separate `__doLogout` action), so external callers cannot bypass the lock; the IIFE has a dedicated `try/finally` around `this.loading` so UI loading state cannot get stuck even if a cleanup step throws a way `safeRun` does not catch.
- `login()`, `register()`, `refreshSession()` each `await __logoutInflight` at their start (when non-null). New authentication requests never see residual WebRTC PCs, signaling WS, SSE handles, timers, or store state from the departing user.
- `updateProfile()`, `updateSettings()`, `changePassword()` return early with an `errorMessage` set when a logout is in flight. Previously, a server response arriving during logout would re-merge into `this.user = null` and revive it as a partial object — e.g. `UserProfilePanel` would then show a "Name updated" success toast even though the API call never happened. Setting `errorMessage` pushes those UI paths into the error branch instead.
- `AuthedLayout.__onSessionExpired` now checks `isLogoutInflight()` at entry and bails. When the current user is already running a logout flow (e.g. user-clicked logout whose API itself 401s), this stops the handler from kicking off a second cleanup and a conflicting `router.replace('/login')`.
- Export `isLogoutInflight()` for callers that want a read-only check without touching the Promise, and `__resetAuthInternals()` for test cleanup.

The lock is deliberately module-level (not Pinia state) so Promises stay non-reactive.
