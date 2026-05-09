---
"@coclaw/openclaw-coclaw": patch
---

Extend the gateway handshake retry tail with six more `20s` slots, taking the table from 9 retries (~80s budget) to 15 retries (~200s budget). Once the table is exhausted the bridge enters a sticky `gave-up` state and only `stop+start` can revive it, so the budget needs to cover slow-start scenarios (profile init, cold disk, first-time pion subprocess spawn) — `~80s` was easy to exceed and led to a permanent offline state on chat RPCs until the user restarted the plugin. The front-loaded head and existing semantics are unchanged.
