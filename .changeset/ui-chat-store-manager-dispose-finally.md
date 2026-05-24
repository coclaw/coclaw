---
'@coclaw/ui': patch
---

fix(ui): guarantee chat-store-manager index cleanup on dispose / promote failure

`dispose(storeKey)` previously called `store.dispose()` then `store.$dispose()`
without guarding either; if either threw, the trailing
`instances.delete(storeKey)` + `topicLru.splice(...)` never ran, leaving a
half-disposed store in both indices. The next `get(storeKey)` would return
that zombie reference and any caller acting on it would either re-throw or
silently read stale state.

`promoteToTopic` had a related leak: a newly created topic store is inserted
into `instances`/`topicLru` by `get()`, but if the subsequent
`newStore.activate({skipLoad:true})` threw, the new store was never rolled
back. Re-entering the same topicId would yield an uninitialized store.

Now `dispose` wraps each release step in its own try/catch (warns + swallows;
contract tightens to "never throws") and always reaches the index cleanup.
`promoteToTopic` snapshots `instances.has(newStoreKey)` before `get()` so
that an `activate()` failure rolls back only stores the call itself created
— a pre-existing same-key store (rare race, covered by existing test) is
left untouched. The original error is rethrown either way.

`__evictTopics`'s outer try/catch + hard-cleanup branch becomes dead path
under the new dispose contract; kept as defense-in-depth so a future
regression to "dispose may throw" stays contained.
