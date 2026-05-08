---
"@coclaw/ui": patch
---

fix(ui): clear orphan ended-run streaming placeholder after successful loadMessages

When RTC truly drops during an accepted agent run, sendMessage resolves with `endReason='failed'` but the silent loadMessages on `__awaitPersistAndDrop` fast-fails (entry uses `getReadyConn` which returns null while DC is just closed), so the `onMessagesPersisted` hook never fires and `dropRun` is never called. After PC rebuild and the connReady watcher triggers another loadMessages, that caller doesn't pass the hook either; reconcile only delegates to `stripLocalUserMsgs` which early-returns on ended runs, leaving the streaming claw placeholder permanently orphaned ("thinking..." stuck on screen with the cancel button gone).

Add an idempotent fallback at the end of `loadMessages` success path (and the topic-mode `__loadTopicMessages` mirror): when the chat has an ended-but-not-dropped run, proactively call `dropRun` with `expectedRunId` guard. Covers both the initial fast-fail path and the post-rebuild reload path; safe under concurrent register/supersede races.

Known root limitation tracked separately as the X4 task in `ui/TODO.md`: `streamingMsgs` is the front display carrier, so `dropRun` can lose partial reply when the plugin hasn't persisted the run yet. X1 narrows but doesn't eliminate this — full fix requires splitting placeholder vs frozen snapshot semantics.
