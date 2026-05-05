---
'@coclaw/openclaw-coclaw': patch
---

Add diagnostic logs around the rpc-routing tables in `realtime-bridge.js` for local verification of the recently-introduced unicast paths. Five permanent `info` lines mark routing-table mutations: `[run-event-route] add` / `[run-event-route] remove` (runId → connId table) and `[rpc-res-route] add` / `[rpc-res-route] remove reason=final-res` / `[rpc-res-route] remove reason=send-failed` (reqId → connId table). Five temporary `debug` lines (each preceded by `/* c8 ignore next -- TODO: 2026-5-20 后删除 */`) report hit/miss outcomes for both tables to confirm unicast vs. fallback-broadcast behavior in dev. The c8-ignore guard means the temporary lines can be deleted on the cleanup date without touching tests or affecting coverage. No behavior change beyond the added log calls.
