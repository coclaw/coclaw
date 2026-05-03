---
'@coclaw/ui': patch
---

Fix intermittent chat scroll-up jump-to-bottom caused by browser scroll anchoring colliding with the position-restore math. After history is prepended, Chrome/Edge/Firefox (with default `overflow-anchor: auto`) silently shift `scrollTop` by the inserted height to keep the visual anchor stable; the existing `el.scrollTop += (newHeight - prevHeight)` then doubled that adjustment, occasionally overshooting past `max scroll` so the user got pushed to the bottom. Switch both `__loadMoreHistory` branches (in-session pagination via `loadOlderMessages` and cross-session via `loadNextHistorySession`) to absolute assignment using a snapshot of the entry-time `scrollTop`, which yields the correct final position whether or not the browser anchored. Browser anchoring stays enabled for the rest of the chat (image loads, thinking-step expansion, etc.) so visual stability there is preserved.
