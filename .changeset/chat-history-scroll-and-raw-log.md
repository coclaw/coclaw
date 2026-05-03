---
'@coclaw/ui': patch
---

Fix chat history scroll-up jumping to bottom and add raw-content debug logs for history loading. The compensatory `scrollToBottom` in `__loadMoreHistory`'s `finally` relied on `userScrolledUp` to gate the scroll, but that signal misclassified intent in two real scenarios — short conversations where `userScrolledUp` is always `false`, and post-restore positions near the bottom where the async scroll event flips the flag — so the just-loaded history got pushed off-screen. Removing the compensation lets the existing `chatMessages` watcher and `ResizeObserver` handle scroll-to-bottom for normal paths (image load, streaming chunks, soft keyboard), while autoFill still lands at bottom via natural `scrollTop` clamping. `loadOlderMessages` and `loadNextHistorySession` now both emit `console.debug` raw-content dumps in the same shape as `loadMessages`, so historical session content is inspectable locally.
