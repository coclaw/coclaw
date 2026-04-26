---
"@coclaw/ui": patch
---

fix(ui): wait for OpenClaw transcript persistence before dropping streaming overlay

Bug 1 surfaced as agent replies showing "task incomplete" until the user
left and re-entered the chat. Root cause is a timing race in the OpenClaw
gateway: the `lifecycle:end` event is emitted before the `await
persistCliTurnTranscript` call that writes the final assistant message
to the session transcript file (which `chat.history` reads). UI had four
OR-gated `endRun` signals with first-wins semantics, and `lifecycle`
typically beat the `rpc` two-phase response. So the post-accepted
`runPromise.then(...)` hook tore down the streaming overlay and reloaded
chat history while the transcript was still mid-write — the latest
assistant lacked `stopReason`, `resultText` resolved to null, and the
component fell back to the "task incomplete" branch.

`chat.store` now distinguishes `endReason === 'rpc'` (upstream guarantees
transcript is already flushed at that point — async/await chain in
`agent-command.ts` runs persist before responding) from the rest. The
fast path drops the overlay immediately; other paths wait 1s, reload,
verify the latest assistant after the run anchor carries a non-`toolUse`
`stopReason`, then retry once after another 2s if still missing. If both
attempts come back without `stopReason`, the UI falls back to the legacy
behavior (drop overlay even though display will degrade) and emits a
single `agent.run.persist-stale` remote log so the rare upstream
persistence failures stay visible. Silent loadMessages failures still
preserve the overlay and rely on the existing 24h watchdog and
re-entry/reconnect reload paths.
