---
'@coclaw/openclaw-coclaw': patch
---

Bound plugin→gateway handshake retry with exponential backoff (5s/10s/20s/20s/20s, max 5 retries) and add v3→legacy fallback within the same WebSocket. Fixes log flooding where a persistent handshake failure (e.g., `device signature invalid`) could emit hundreds of `ws.connect-failed` / `ws.disconnected` lines per minute to the CoClaw server, drowning out unrelated diagnostics.

- On `connect.challenge`, the plugin still sends v3 (with `device` field) by default. If the response is `ok:false` and the error message matches `/signature|device|scope|protocol/i`, the plugin retries once with a legacy (no-device) handshake on the **same WebSocket** — no new connection, no counted failure. The learned legacy preference is cached in memory and used for subsequent WebSockets (reset on plugin/gateway restart).
- Handshake failures that are not signature/protocol-related — or legacy retries that also fail — close the WebSocket and schedule the next attempt per the backoff table. After 5 retries are exhausted (6 total attempts, ~75s), the bridge enters a terminal `gave-up` state and does not attempt gateway reconnection again until the plugin or gateway restarts.
- Duplicated `ws.disconnected peer=gateway` log is suppressed when the close was a direct consequence of a just-reported `ws.connect-failed`, collapsing two lines into one per failed attempt. Genuine "connected then dropped" disconnects still log as before.
- The existing successful-handshake path is byte-identical for modern OpenClaw gateways: no v3 regression.
