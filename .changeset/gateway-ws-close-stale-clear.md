---
'@coclaw/openclaw-coclaw': patch
---

Fix: gateway WS close handler moves `__clearAllLagProbes` / `gatewayPendingRequests.clear` / `__dcPendingRequests.clear` / reconnect scheduling to after the `this.gatewayWs !== ws` stale guard. All three cleanups touch per-bridge shared state; running them before the guard meant a stale-ws close would wipe the new ws's lag probes, pending RPCs, and DC routes. Per-WS log lines (disconnected / handshake info) stay above the guard since they reference closure-local variables.
