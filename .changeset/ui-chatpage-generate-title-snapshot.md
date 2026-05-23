---
'@coclaw/ui': patch
---

fix(ui): pin auto-title generation to the chat the message was sent from

`__tryGenerateTitle` previously read `this.chatStore` / `this.isTopicRoute`,
which is whatever the user is currently looking at. If the user sent a
message from topic A, then swiped to topic B (or a non-topic chat) while
the `sendMessage` await was still in flight, the post-accept branch
would trigger title generation against B — letting an LLM name an
unrelated chat.

The function now takes a `targetStore` snapshot captured at the
`sendMessage` entry. Both call sites (`__handleSend` and
`__handleNewTopicSend`) pass their existing `targetStore` variable.
The `!this.isTopicRoute` guard is removed; the function now checks
`targetStore.topicMode` (a store-level property unaffected by current
route).
