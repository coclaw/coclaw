---
'@coclaw/ui': patch
---

fix(ui): make MainList row actions visible on keyboard Tab focus

The three trailing action containers on each list row (`.agent-actions`,
`.web-agent-actions`, `.topic-actions`) were `opacity-0
group-hover:opacity-100`. Keyboard users tabbing through the list landed
focus on the action trigger button but the button was invisible — only
the mouse-hover and touch-device (`@media (hover: none)`) paths had
coverage.

Add `group-focus-within:opacity-100` to all three classes so the button
becomes visible whenever any descendant (the trigger) receives focus.
Existing hover and touch paths are unchanged.
