---
'@coclaw/ui': patch
---

fix(ui): i18n the "More" aria-label on row action trigger buttons

`AgentItemActions`, `TopicItemActions`, and `WebAgentItemActions` all
rendered their popover trigger button with a hard-coded English
`aria-label="More"`. Screen-reader users on Chinese / Japanese / Korean
etc. heard mixed-language output. Wire the trigger label through a new
`common.moreActions` i18n key, translated across all 12 locales.
