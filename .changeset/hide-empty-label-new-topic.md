---
'@coclaw/ui': patch
---

Drop the "no messages" placeholder from the chat screen.

Both new topics and freshly-loaded chats show a blank area above the composer, which is already a clearer "start typing here" cue than a system-style empty-state line. Removed the i18n key across all locales to keep strings honest.
