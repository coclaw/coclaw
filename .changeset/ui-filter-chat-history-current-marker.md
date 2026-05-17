---
'@coclaw/ui': patch
---

In `chatStore.__loadChatHistory`, filter entries returned from
`coclaw.chatHistory.list` whose `archivedAt` is `null` or missing. The plugin
side is moving to a contract where the current session is appended to the
chat-history file as a normal entry without `archivedAt`, used as an implicit
"this is the current session" marker. The UI still consumes the list with the
old "orphan sessions only" semantics, so the current-session entry is dropped
at the source to keep all downstream paths (loadNextHistorySession,
historySegments, /new + /reset archival) untouched.

The `!=` comparison (rather than `!==`) is intentional so that both `null` and
`undefined` (field absent) are filtered out — the plugin may use either form.

Forward compatible: with the old plugin (no current-session entry written),
the list is unchanged, so the filter is a no-op.
