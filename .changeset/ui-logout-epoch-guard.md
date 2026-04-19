---
'@coclaw/ui': patch
---

fix(ui): guard auth actions against user-data writes that await across a logout

Follow-up to the `__logoutInflight` lock: the entry guard only prevents an action
from starting while a logout is already in flight. It does not cover the window
where an action has already passed the entry check and is awaiting its API
response when a logout starts and completes.

Concrete scenario: `visibilitychange` fires `refreshSession()` → checks
`__logoutInflight` (null), calls `fetchSessionUser()` and awaits. The user
then clicks Logout; the full logout cleanup runs and `__logoutInflight` returns
to null. When `fetchSessionUser` finally resolves, `this.user = data` revives the
just-cleared user — the AuthedLayout watch re-fires, WS/SSE reconnect, Pinia
state is half-reset, half-populated. The same shape affects `login`,
`register`, `updateProfile`, `updateSettings` (the latter two previously merged
the response into `this.user = null`, reviving it as a partial object).

Fix: add a module-level `__logoutEpoch` counter, bumped synchronously at the
start of every `logout()` IIFE. Each of the five actions captures the epoch
before its first `await`; after the await, if the epoch has changed, the
action drops its result (both the success-path write and the catch-path
`errorMessage`) without touching store state. This complements, not replaces,
the existing entry guard.
