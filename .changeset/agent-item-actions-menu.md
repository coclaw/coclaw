---
'@coclaw/ui': minor
---

feat(ui): add context menu to agent items in MainList

Each agent row in the MainList sidebar now exposes a right-side "…" button (hover-reveal on desktop, always-visible on touch devices) that opens a popover with two entries:

- **Chat** — navigates to the agent's main chat (equivalent to clicking the row itself).
- **Files** — opens the file manager for that agent (a third entry alongside the existing entries on the chat page header and `/claws`).

Style and interaction model mirror the existing `TopicItemActions` so both lists share one visual language. The menu stays available regardless of claw online/offline state — downstream pages (`ChatPage`, `FileManagerPage`) already handle their own connectivity fallbacks.
