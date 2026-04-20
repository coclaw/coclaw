---
'@coclaw/ui': patch
---

fix(ui): align MainList Capacitor header action buttons with ChatPage

MainList's Capacitor-only header (logo + refresh + "+") rendered its
icon buttons with `size="xl"` and relied on the header-level `gap-2`
for all siblings, producing 24 px icons and an 8 px gap between the
refresh icon and the "+" button. ChatPage's mobile header renders
refresh/new-topic via `MobilePageHeader`'s actions slot — default
`md` size (20 px icons) packed tightly with no inner gap.

Drop `size="xl"` from the three action buttons (RTC connecting
spinner, RTC unreachable warning, add-claw plus) and wrap them in a
no-gap `<div class="flex shrink-0 items-center">` inside the header.
The outer header keeps its `gap-2` so logo/title/actions-group stay
separated, while the three action buttons are now flush with each
other and sized identically to ChatPage's refresh/new-topic icons.
