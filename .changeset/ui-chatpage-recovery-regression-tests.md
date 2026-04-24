---
"@coclaw/ui": patch
---

Lock in ChatPage `connReady` watcher contracts across claw/sig offline-online gating + RTC rebuild / ICE restart paths with a new regression suite (6 tests, no production-code changes).

ChatPage already reconciles messages after rebuild via its `connReady` watcher (`ChatPage.vue` `watch.connReady.handler` → `__onConnReady` → `chatStore.loadMessages({silent:true})`), driven purely by `claw.dcReady` flips. The prior test file covered the happy-path flips (online→true, first-mount, sending-skip, chatStore re-activate) but not the subtler invariants around the dual gate (claw presence / signaling WS) introduced across rounds 11-14 and now codified in `__handleClawGoOffline` / `__freezeAllClawsForSigOffline`. Those two gates deliberately leave `dcReady` / `rtcPhase` untouched (presence + environmental-fault are orthogonal to DC lifecycle — see `docs/architecture/communication-model.md` §5.5 / §5.5.1), so the UI's reconcile is meant to stay quiet across both gates and only react to the underlying DC state.

Added `describe('ChatPage recovery watchers')` at the bottom of `src/views/ChatPage.test.js`:

- **T1** — `claw.online=true→false` (via `updateClawOnline`) does not touch `dcReady`; `connReady` stays true and the silent-reload watcher does not re-fire. Locks "`__handleClawGoOffline` is presence-only".
- **T2** — After claw offline the DC eventually closes (`dcReady=false` / `rtcPhase='failed'`), `connReady` flips false, and when online returns with a new DC (`dcReady=true`) `loadMessages({silent:true})` is called exactly once. Full cycle via `dcReady` flip.
- **T3** — ICE restart with DC continuity: `rtcPhase` bounces `ready → restarting → ready` while `dcReady` stays true throughout; `connReady` stays true and no silent reload fires. Locks "short RTC jitter does not churn data" (per `claws.store.js` `__rtcCallbacks` state=`connected` wasDisconnected=false branch).
- **T4** — ICE restart that forces a DC rebuild: `dcReady` goes `true → false → true`; exactly one silent reload fires after the rebuild.
- **T5** — `__freezeAllClawsForSigOffline` leaves `dcReady` untouched (only invokes `__clearRetry` + `pauseRestart`); `connReady` stays true and no reload fires. Sets `clawsStore.fetched=true` explicitly so the freeze body actually executes (`setClaws` doesn't set `fetched`; the early-return at the top of the freeze action would otherwise make the assertion vacuous).
- **T6** — First mount during sig-offline with `dcReady=false` (`__fullInit` blocked by sig gate): `connReady` starts false and immediate watcher early-returns; once sig recovers and the full init completes (`dcReady=true`), the watcher fires `loadMessages()` (first-load path, non-silent).

Each test has ≥3 precise assertions (exact call counts + exact argument shapes where applicable, not just `toHaveBeenCalled`). No business-code or other-test-file changes. `pnpm test` UI: 2925 → 2931 passing, 0 skipped. `pnpm check`: 0 errors.
