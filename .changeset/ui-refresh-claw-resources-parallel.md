---
"@coclaw/ui": patch
---

fix(ui): parallelize refreshClawResources sub-loads, gate only sessions on agents

After RTC reconnect recovery, `refreshClawResources` used to await `loadAgents`
before firing topics, sessions, and dashboard. Only sessions actually depends
on the agent list (the fallback `['main']` would miss non-main agents added
during the disconnect window) — topics is hard-coded to `agentId='main'` and
dashboard runs its own internal `loadAgents`. Fire all three immediately and
keep the agents promise as a gate only for sessions, removing one round-trip
from every reconnect-recovery refresh.
