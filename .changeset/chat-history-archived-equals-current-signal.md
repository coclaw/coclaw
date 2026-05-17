---
'@coclaw/openclaw-coclaw': patch
---

Surface `archivedSessionId === currentSessionId` upstream-contract anomaly via
`remoteLog('chat-history.archived-equals-current ...')` instead of swallowing
it. The case happens when the gateway `session_start` hook delivers
`resumedFrom === sessionId` (an upstream-contract anomaly that should not
occur). The normalization (drop `archivedSessionId` to avoid a duplicate
head/archived entry in the same on-disk list) is unchanged; only the
diagnostic signal is added so a future upstream regression surfaces in remote
logs instead of silently disappearing.

No behavior change on the happy path — the log is only emitted on the
anomaly. Issue surfaced by the 8th-round deep-review (R-A SHOULD-S2).
