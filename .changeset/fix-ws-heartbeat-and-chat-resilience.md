---
"@coclaw/ui": patch
"@coclaw/server": patch
---

fix(ui,server): add WS heartbeat and improve chat disconnect resilience

- UI WS client: 25s ping / 45s timeout heartbeat to detect silent disconnections on mobile
- Server: respond to application-level ping/pong + WS protocol-level ping for UI connections
- ChatPage: 30s pre-acceptance timeout to prevent infinite "thinking" state
- ChatPage: suppress duplicate error toasts when timeout/lifecycle:end already handled
- ChatPage: lifecycle:end uses fresh WS connection for refresh; preserves user message on failure
