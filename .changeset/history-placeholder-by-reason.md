---
"@coclaw/ui": minor
---

Tell apart "conversation gone" from "conversation corrupted" in history placeholders

The chat history list now consumes the richer `coclaw.sessions.getById` signal to
give a precise reason instead of one generic placeholder:

- A `NOT_FOUND` rejection renders the existing neutral "no longer available"
  placeholder with `reason: 'missing'`; a `PARSE_FAILED` rejection renders a new
  "this conversation appears to be corrupted" message (`reason: 'corrupt'`).
- Topic mode surfaces the matching localized error text by error code.
- Forward-compatible with an older plugin: that plugin still returns an empty
  message list (no error) for a missing transcript, which keeps flowing through
  the same empty-segment placeholder (no `reason`, neutral text) — so the history
  never silently drops a segment regardless of plugin version.

Transient errors (RTC loss, RPC timeout) keep their previous behavior. Adds a
`chat.historyCorrupt` string across all locales.
