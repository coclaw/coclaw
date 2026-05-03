---
'@coclaw/ui': patch
---

Preserve full toolCall / toolResult data through the live and replay paths so the renderer (when it grows args/pairing UI) has everything it needs:

- **Live (`agent-stream.js`)**: `phase: 'start'` toolCall block now carries `toolCallId` and `args` in addition to `name`. `phase: 'result'` toolResult message now carries `toolCallId`, `name`, `isError`, and `meta` alongside the existing text content.
- **Replay (`session-msg-group.js`)**: the `tool_use` block's Anthropic-standard `id` / `input` are mapped to `toolCallId` / `args` when projected to a step (so step shape is uniform across both paths). The `toolCall` block (CoClaw streaming format) keeps its `toolCallId` / `args`. `processToolResult` now passes through `toolCallId` and `isError` to the toolResult step.

No rendering change — the chat message component still only paints the tool name pill. The data is now preserved end-to-end so a follow-up renderer pass (args expansion, toolCallId-based pairing for parallel tool calls, partial-result streaming) can land without re-touching the data layer. See `ui/TODO.md` items #47–#49 for the rendering backlog.
