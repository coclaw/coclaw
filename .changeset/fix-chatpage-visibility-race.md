---
"@coclaw/ui": patch
---

fix(ui): unlock first-screen visibility when force scrollToBottom races autoFill history

ChatPage cold-start could leave the entire panel permanently hidden when the chatMessages watcher's autoFill landed first and raised `__loadingHistory`, causing the force scrollToBottom path from `__onConnReady` to early-return without flipping `__scrollReady` on. Force-path early-returns now flip the visibility gate on before returning. Switching away and back used to be the only recovery.
