---
'@coclaw/ui': patch
---

fix(ui): rebind claws-store window lifecycle listeners after logout+relogin

`__bridgeLifecycle` guarded against duplicate registration with a
`this.__lifecycleBridged` flag set on the Pinia store **instance** — not
declared in `state()`. On logout, `__resetClawStoreInternals()` correctly
removed the `app:background` / `app:foreground` / `network:online` window
listeners, but `claws.$reset()` only restores declared state and left the
instance flag set to `true`. On re-login in the same tab/app, `__bridgeConn`
called `__bridgeLifecycle()`, the flag short-circuited, and listeners were
never re-attached — silently breaking mobile RTC auto-recovery after
background/foreground and Wi-Fi↔cellular transitions until a full page
reload.

Lift the flag to a module-level `_lifecycleBridged` variable next to
`_lifecycleHandlers`, and reset both in the same logout cleanup helper.
Add a regression test that logs out and re-bridges on the same store
instance, asserting `app:foreground` probes fire in both cycles.
