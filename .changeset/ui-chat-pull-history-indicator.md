---
"@coclaw/ui": minor
---

ChatPage: add visual indicator for touch pull-to-load-history.

Before this change, the touch pull-down gesture for loading older history was
working but completely silent — no on-screen feedback while pulling. This adds
a small circular overlay indicator (mobile-only) that follows the finger,
fades in as the pull approaches the 60px threshold, switches to a refresh
icon past the threshold, and spins while the gesture-triggered load is in
flight. The visual is gated to gesture-triggered loads only — non-gesture
load paths (auto-fill, scroll-to-top, wheel) intentionally do not light it
up.

The trigger logic, race-hardening guards in the history loader, watcher
state cleanup on chat switch, and scrollTop restoration are all unchanged.
