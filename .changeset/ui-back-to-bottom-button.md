---
'@coclaw/ui': patch
---

Add a "scroll to bottom" floating button on the chat page.

When the user scrolls more than one viewport away from the bottom of the
message list, a 40×40 circular arrow-down button appears 32px above the
input area (including any attachment preview row, since attachments live
inside the same sticky input footer). Tapping it jumps back to the
latest message (instant scroll, matching the existing
`scrollToBottom(true)` behavior) and the button hides again. It is also
suppressed while history is loading at the top so a tap can't appear to
no-op.

The button reuses the existing `scrollToBottom(true)` path and tracks a
new `farFromBottom` state alongside the existing `userScrolledUp` flag,
so the 60px "stop auto-tail" threshold and the 1-screen "show jump
button" threshold stay independent. All explicit "scroll to bottom"
entry points (chat switch, send message, new-topic send, reconnect via
`__onConnReady`) also reset `farFromBottom` to keep the button in sync
with the force scroll. A ResizeObserver-driven refresh covers content
and viewport size changes that don't fire a scroll event (e.g. streaming
output, soft keyboard).

Implementation notes:

- A new `<slot name="floating" />` on `ChatInput`'s sticky footer hosts
  the absolutely-positioned button, so the button's anchor automatically
  follows the footer's top edge as the attachment row appears or
  disappears — no extra positioning JS needed.
- The button has an `aria-label` driven by a new `chat.scrollToBottom`
  i18n key, synced across all 12 locale files.
