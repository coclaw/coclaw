---
'@coclaw/ui': patch
---

fix(ui): unbind dialog dismiss + per-claw concurrency + 404 self-heal

ManageClawsPage `onConfirmRemove` previously closed the confirm modal
and refreshed local state **only** on a 200 success. Any error path
(including the server's 404 CLAW_NOT_FOUND response) left the modal
permanently open and the local claw card stale, forcing the user to
hard-refresh the browser to recover.

Three layered changes:

- **Dismiss-first**: clicking confirm now closes the modal synchronously
  before the unbind API call, so the modal never gets stuck regardless
  of what the network does afterward.
- **404 self-heal**: catch path now recognizes
  `err.response.data.code === 'CLAW_NOT_FOUND'` (or HTTP 404) as
  semantically equivalent to a successful unbind — the server says
  the claw is already gone for this user, but SSE will not push
  `claw.unbound` because the server never actually executed an unbind.
  In that case the page proactively calls
  `clawsStore.removeClawById(clawId)` so the local card disappears
  without a refresh. Other errors (401/network/5xx) only toast and
  close the modal, leaving the local claw intact for retry.
- **Per-claw concurrency**: the single-slot `unbindingId` is replaced
  with a per-claw `unbindingMap`. The same claw cannot be confirmed
  twice while a request is in flight (the card-level Remove button
  binds both `:loading` and `:disabled` for double protection), but
  different claws may unbind concurrently without blocking each other.

The map's lifecycle is contained entirely inside `onConfirmRemove`:
written synchronously before any `await`, deleted in `finally`.

Tests:

- Unit: new cases for 404 self-heal, dismiss-before-API ordering, the
  per-claw concurrency invariant, the same-claw reentry guard, and a
  DOM-level assertion that the Remove button reflects both
  `:loading` and `:disabled` when a claw is in-flight (so the
  `:disabled` half cannot be silently dropped later).
- E2E: the existing bind/unbind flow is rewritten to walk through the
  confirm modal (which it never did before — the modal was added
  after the test was written and the test had been clicking past it).
  A second `@bind` test mocks the unbind endpoint with a 404 response
  to assert the self-heal path end-to-end.
