---
'@coclaw/ui': patch
---

fix(ui): clear pending cancel intent in slash command cleanup

`__pendingCancelIntent` is consumed by the normal-message flow's
`onAccepted` handover — it transitions a pre-accept STOP click into a
real cancel once the server confirms. Slash commands take a different
RPC path (`chat.send`) and never trigger `onAccepted`, so an intent set
during slash execution had no consumer and lingered after the command
finished, keeping `isCancelling` stuck at `true` and the STOP button in
its "cancelling" disabled state until the next outgoing message.

In practice the STOP button is disabled during slash commands at the UI
layer (ChatPage `cancel-disabled`), so users can't normally reach
`cancelSend()` to set the intent in the first place. But programmatic
paths (E2E scripts, direct store calls) bypass that guard, and future
regressions in the UI disable logic would silently expose the stuck
state. Clearing the intent at the top of `__cleanupSlashCommand` makes
the cleanup function the complete state sink for slash command
termination across all six exit paths (timeout, RPC failure, RPC throw,
event final, event error, WS reconnect).
