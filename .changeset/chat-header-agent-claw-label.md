---
'@coclaw/ui': minor
---

feat(ui): show `<agentName>@<clawName>` label in ChatPage header

Both the mobile (`MobilePageHeader`) and desktop ChatPage headers now render the chat title as an agent-and-claw label, matching the `MainList` rendering strategy:

- Single-claw users see only the agent name (no `@<clawName>` suffix).
- Multi-claw users see `<agentName>@<clawName>`, with `@<clawName>` rendered in the muted text color as secondary information.
- When the agent name is identical to the claw name (default-agent fallback), the suffix is dropped to avoid `Alpha@Alpha` duplication.

Unlike `MainList`, the label is treated as one truncate unit (single ellipsis on the entire `<agentName>@<clawName>` line), instead of truncating each segment independently. `MobilePageHeader` now exposes a default slot so callers can supply structured title content while keeping the existing `title` string prop as fallback.
