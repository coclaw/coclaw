---
"@coclaw/ui": patch
---

fix(ui): advance streaming anchor when stripping optimistic user msg

Manual refresh during an active agent run could render the current bot turn as "task incomplete" while the run was still actively executing. Root cause: `stripLocalUserMsgs` removed the optimistic user placeholder once the server had persisted the real user message, but left `anchorMsgId` pointing at the previous turn's assistant final. The `allMessages` getter then inserted the remaining streaming claw placeholder between the previous assistant final and the new server user message. Grouping merged the placeholder into the previous bot task, leaving the current bot task without the streaming flag, which fell through to the "task incomplete" fallback.

Fix: in `stripLocalUserMsgs`, advance `anchorMsgId` to the first server user message strictly after the previous anchor when stripping (only on the with-anchor branch; the no-anchor branch keeps the anchor null and lets `allMessages` fall back to appending streaming messages at the end). Subsequent merges then insert the streaming placeholder after the new user message, restoring correct grouping.

Regression introduced in commit 55212ea (2026-04-06) which added the anchor scaffolding without the corresponding advancement step.
