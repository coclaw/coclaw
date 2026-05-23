---
'@coclaw/ui': patch
---

fix(ui): throw CLAW_DISCONNECTED instead of returning topicId when claw unbinds mid-createTopic

Follow-up to the createTopic mid-unbind guard. The previous fix correctly
skipped the local `byId` write when `clawsStore.byId[clawId]` was empty
after the await, but still returned the `topicId` to the caller. The sole
caller `ChatPage.__handleNewTopicSend` took that id, promoted the
`new-topic:*` store to `topic:*`, called `router.replace` to the new
topic route, and finally invoked `sendMessage`. Because `topicsStore.byId`
was deliberately not written, the new route's `chatStore` computed
hit `topicsStore.findTopic(sid) === null` and returned null — the user
ended up on a blank topic page while the trailing `sendMessage` rejected
on a disconnected claw.

Now `createTopic` throws an `Error` with `code = 'CLAW_DISCONNECTED'`
when the claw vanishes during the await. `ChatPage`'s existing catch
restores draft / files / `__creatingTopic`, and the codeMap maps the new
code to `chat.errWsClosed` ("Connection lost") so the user sees a clear
toast instead of a blank route. The plugin-side JSON record is still
preserved — rebinding the same claw rehydrates the topic via
`loadTopicsForClaw` as before.
