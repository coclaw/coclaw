---
'@coclaw/ui': minor
---

feat(ui): order MainList agents by recent activity and add @claw suffix

Agent items in `MainList` are now ordered by their most recent chat activity (descending), with no-activity agents at the bottom in their natural `agents.list` order. Activity comes from two sources merged at sort time: `updatedAt` from `sessions.list` (server truth) and a local `bumpedAt` written at the moment the user calls `sendMessage` / `sendSlashCommand`, so a freshly-active chat floats to the top instantly without waiting for the next `sessions.list` refresh.

When the user has 2+ claws, agent labels now render as `agentName@clawName` to disambiguate; with a single claw the label stays just `agentName`. The `@` separator never truncates while both `agentName` and `clawName` segments truncate independently when space is tight. To avoid `Alpha@Alpha` duplication when the default agent has no identity (its display name falls back to the claw name), the suffix is dropped when the two would be identical.

Internally, `sessions.store` switched its data source from `chat.history` (one RPC per agent) to `sessions.list` (one RPC per claw), and item shape gained `updatedAt` and `bumpedAt` fields with a new `bumpActivity(clawId, agentId)` action and `getActivity` getter. Sessions are now grouped from the live list by `agent:<agentId>:` key prefix so orphan sessions count toward the chat's activity too.
