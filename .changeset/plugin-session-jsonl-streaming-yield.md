---
"@coclaw/openclaw-coclaw": patch
---

Stream session JSONL parsing to keep the gateway event loop responsive on large transcripts. `coclaw.sessions.get` / `getById` previously did `text.split(/\r?\n/)` on the full file then a tight synchronous loop of `JSON.parse` per line — both were single CPU bursts that could stall the WebRTC ack/event-forwarding path for hundreds of milliseconds on a multi-MB transcript. The new path scans line boundaries with a cursor (no whole-string split) and yields to the event loop via `setImmediate` every 100 lines, so other I/O callbacks (RTC frames, concurrent RPC handlers) can interleave. Adds a reusable `iterTextLines` helper in `src/utils/text-line-stream.js` for any future large-text line scanning.
