---
'@coclaw/ui': patch
---

fix(ui): stop misjudging agent run as failed when agent.wait probe RPC rejects

The watcher's `__pollOnce` catch branch used to call `__endRun('failed')` on any
agent.wait reject, which incorrectly judged the run as dead during ICE restart
windows where the wait RPC's wall-clock timeout (33s) fires while the run is
actually still alive on the gateway side. The bot bubble would then render the
"任务未完成" placeholder despite the agent still working.

The catch branch now retries pollOnce immediately, treating reject as
"timeout(no endedAt)" — the same as the server's own timeout response. Death
judgment stays solely with signal 4 (the main agent() RPC, which uses
timeout=0 and only rejects on physical DC death). Microtask FIFO order
guarantees the main RPC's onRejected runs before the wait catch in the
DC-death case, so r.ended is true by the time the wait catch's guard runs —
no hot loop. Also includes corresponding test coverage and design doc sync.
