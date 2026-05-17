---
'@coclaw/openclaw-coclaw': patch
---

Filter unarchived head from `coclaw.chatHistory.list` RPC by default to protect
old UIs from displaying the current active session as an orphan history item.

The chat-history file schema (introduced with dual-source archival) places the
current active session as an unarchived head item. UIs from before commit
`2a00e56` (`fix(ui): filter current-session marker from coclaw.chatHistory.list`)
do not filter this head and will show the active session at the top of the
orphan history. The plugin now filters it server-side by default; new UIs can
still request the full array by passing `includeCurrent: true` in the RPC
params. The underlying `chatHistoryManager.list()` retains `includeCurrent: true`
as its default to preserve existing test contracts.
