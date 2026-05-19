---
'@coclaw/ui': patch
---

Defensive tolerance for plugin chat-history list anomalies in the chat history loader.

`coclaw.chatHistory.list` returns a list whose head (index 0) carries
`archivedAt == null` to mark the "current live session". The previous
loader filtered out **any** entry with `archivedAt == null`, which was
position-agnostic blanket drop. In rare upstream race conditions
(OpenClaw cross-channel event reordering / plugin-gateway hook lag /
`chat.history` lagging behind `chatHistory.list`), the head entry may
not in fact be the main channel's real live `sessionId`. In that case
the blanket filter silently dropped a session that should have been
shown in history.

UI now stores the raw list as a separate state slot and exposes the
filtered list as a Pinia getter (`historySessionIds`) that derives from
`rawHistorySessionIds + currentSessionId`:

- non-head entries with `archivedAt == null` are always kept (anomaly
  defense — they are never legitimate live markers under the plugin's
  contract)
- head with `archivedAt == null` is dropped when `currentSessionId` is
  unknown (the common case — head is presumed to be the live marker) or
  when `currentSessionId` is known and matches the head's `sessionId`
- head with `archivedAt == null` is **kept** as a historical segment
  only when `currentSessionId` is known **and** does **not** match —
  this is the defensive branch that catches upstream anomalies

`historyExhausted` is now also a getter (`__historyLoadedCount >=
historySessionIds.length`), so when `currentSessionId` arrives late
and reveals the head as a stale anomaly, the list naturally grows and
"more history" becomes reachable without manual coordination.

Known limitations (covered by frozen test cases):

1. **Race + scroll**: if the user scrolls through all visible history
   **before** `currentSessionId` is known and the head turns out to be
   anomalous, the counter has already moved past index 0; the head
   will not be loaded until the chat is re-entered or refreshed.
2. **Cleanup-after-fix**: if an anomalous head is loaded into
   `historySegments` (because `currentSessionId` was briefly unknown
   or stale-mismatched), and `currentSessionId` is later corrected to
   match the head, the head is removed from `historySessionIds` but
   not from `historySegments`. The chat momentarily renders that
   session twice (once in history, once as the current live area)
   until refresh / re-enter rebuilds `historySegments`.

Both limitations require the same upstream anomaly + a tight
sub-second race window; refresh restores the correct view in either
case.
