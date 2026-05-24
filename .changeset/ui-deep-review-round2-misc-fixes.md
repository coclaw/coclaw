---
'@coclaw/ui': patch
---

fix(ui): deep-review round-2 batch of small UX, defensive, and CSS fixes

- ChatPage: when `createTopic` rejects mid-`__handleNewTopicSend` with
  `CLAW_DISCONNECTED`, replace route to `/`. Previously the user was
  left on `/topics/new?claw=<unbound>`, which is a UX dead-end —
  retapping send re-throws the same error in a toast loop.
- ManageClawsPage: claw-name container gains `min-w-0` and the name
  `<h2>` gains `truncate min-w-0`; the status dot, rename pencil, and
  agent-count badge gain `shrink-0`. Applied to both the dashboard and
  the offline-fallback variants. Prevents long claw names + cost
  blocks from overflowing on narrow mobile viewports.
- AddClawPage: `cancelBindingCode` failure now emits a single
  `console.warn` with the code and the error, instead of swallowing
  silently. Behavior unchanged — codes still expire naturally if
  cancel fails.
- claws.store `__refreshIfStale`: the outer
  `refreshClawResources(...).catch(...)` previously dropped the error
  silently as an unhandled-rejection sentinel. Now logs a `warn` with
  the `clawId` and the error so that any real bug in a future
  defensive layer leaves a diagnostic trail.
- chat-store-manager dispose: the two `warn` lines for
  `store.dispose` / `$dispose` throws now pass the error object as a
  separate arg instead of interpolating `err?.message`, preserving the
  stack and showing the real value for non-Error throws.
- topics.store / sessions.store: the per-claw load cleanup is rewired
  from `promise.finally(cleanup)` to `promise.then(cleanup, cleanup)`.
  `finally` returns a new promise that would convert any internal
  `catch` gap into an `unhandledrejection`; the two-arg `then` form
  swallows the rejection without depending on the inner code never
  regressing.
