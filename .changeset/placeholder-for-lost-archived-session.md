---
"@coclaw/ui": patch
---

Show a placeholder for archived sessions whose transcript content is gone

When an archived session's chat-history pointer survives but its OpenClaw
transcript file is gone (upgrade mishaps, manual cleanup, orphan reclamation),
the history list used to skip the segment entirely while scrolling — the
conversation vanished with no trace, leaving the user unaware it ever existed.
The list now keeps a neutral placeholder ("This conversation is no longer
available") for such empty-content archived segments instead of hiding them.
UI-only display change; the placeholder fires only when the segment's fetched
message list comes back empty.
