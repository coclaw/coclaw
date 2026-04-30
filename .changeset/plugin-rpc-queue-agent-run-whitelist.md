---
"@coclaw/openclaw-coclaw": patch
---

Whitelist agent-run RPC responses from the rpc-send-queue soft-cap drop.

When the per-DC outgoing queue reaches the 10MB soft cap, the queue normally drops new messages so it cannot grow without bound. That rule is too coarse for agent-run terminal frames: a dropped phase-2 `agent` response (or any `agent.wait` terminal) leaves the UI watcher with no way to learn the run ended, and the run sticks in the "incomplete + stop button gone" state.

A frame is now exempt from the soft-cap drop when its top-level `type === 'res'` and `payload.runId` is truthy. The intended targets are the six `agent` / `agent.wait` respond branches (`accepted` / `ok` / `error` / `timeout` / `dedupe` terminal / race terminal). The same condition also catches `chat.send` acks and any other RPC whose response payload happens to carry a top-level `runId` (e.g. `send`/`poll`, `sessions.send`/`steer` which forward `chat.send`'s payload) — the rule is intentionally hardcoded with no per-method allowlist; those incidental responses are small and whitelisting them is harmless. The 50MB single-message hard cap is not exempted (the receiver's reassembly limit — exempting it would only delay an inevitable drop).

Whitelist passes do not increment `droppedCount` / `droppedBytes`, do not flip `queueOverflowActive`, and do not emit overflow-start logs; they are intentionally silent enqueues that may push `queueBytes` above the soft cap until drained.
