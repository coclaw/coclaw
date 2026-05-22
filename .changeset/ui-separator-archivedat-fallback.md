---
'@coclaw/ui': patch
---

Fall back to the adjacent session's first message timestamp when a chat
history separator's `archivedAt` is missing, so the separator label is
never silently blank.

When OpenClaw rotates a session implicitly (e.g. the upstream daily
reset at 04:00 turns the previous day's session stale, then the next
incoming message lands in a fresh session via `crypto.randomUUID()`),
the plugin's chat-history-manager correctly writes `archivedAt` for
the rotated-out session through the `sessions.changed reason=create`
channel. UI's cached `rawHistorySessionIds` however was loaded at chat
entry time and is not re-fetched on implicit rotation — at fetch time
the rotated-out session was still the live head with no `archivedAt`,
so the cached entry stays `archivedAt`-less.

After the rotation, `historySegments` and `historySessionIds[0]` carry
that `archivedAt`-less entry, and the rendered separator label
collapses to an empty string (just a dashed line, no date).

`chatMessages` now computes a fallback for both separator variants:

- segment-to-segment separator (`sep-${sessionId}`): `seg.archivedAt`
  or the first valid `timestamp` in the *next* segment's grouped items
- history-to-current separator (`sep-current`):
  `historySessionIds[0].archivedAt` or the first valid `timestamp` in
  the current session's grouped items

The fallback time is at most seconds off the true `archivedAt` (a new
session's first message is written almost immediately after the
rotation). If even the fallback can't find a valid timestamp the
separator's `archivedAt` is `null` and `formatSeparatorLabel` returns
empty as before — never worse than the pre-fix behavior.

This is a display-layer mitigation; the underlying staleness (UI not
re-fetching chat-history after implicit rotation) is left for a future
event-driven fix where the plugin broadcasts a chat-history patch
event.
