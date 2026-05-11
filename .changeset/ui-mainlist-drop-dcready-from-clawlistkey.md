---
"@coclaw/ui": patch
---

Eliminate the last duplicate first-screen RPC pair (`agent.identity.get` and `tools.catalog`) caused by `MainList`'s `clawListKey` watcher firing when `dcReady` flips `false→true`. The DC-ready transition already triggers `claw-lifecycle.__fullInit → initClawResources`, which fully owns first-screen loading. The watcher's `dcReady` axis was a redundant second trigger that arrived milliseconds later — after the in-flight dedup map in the per-claw caches had already cleared, so duplicate RPCs slipped through.

`clawListKey` now keys only on `id` and `online`. The watcher still fires on claw membership changes and online-state flips (covering new-claw bind, claw removal, presence toggles in either direction), which are not handled by the lifecycle path. The accepted trade-off: lifecycle loaders silently swallow errors (tracked separately in `ui/TODO.md`), so first-screen loading no longer has an opportunistic retry via the watcher when lifecycle fails. Independently fixing that silent-catch is the right path; relying on watcher-as-fallback is not.
