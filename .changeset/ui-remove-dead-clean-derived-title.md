---
"@coclaw/ui": patch
---

Remove dead `cleanDerivedTitle` helper and its supporting regex/format helpers from `session-msg-group.js`. The plugin no longer emits the `derivedTitle` field on session list responses (it was an early prototype, the chat-history/topic title flow superseded it), and no production UI code imports `cleanDerivedTitle`. Drops ~120 lines of source and ~110 lines of tests.
