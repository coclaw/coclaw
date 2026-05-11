---
"@coclaw/openclaw-coclaw": patch
---

Make session-manager fully async to remove synchronous fs reads from the gateway event loop. Listing sessions and loading a session by id (`coclaw.sessions.getById`, `nativeui.sessions.listAll` / `.get`, `coclaw.topics.getHistory`) previously did blocking `readFileSync` on JSONL transcripts during UI refresh, freezing the plugin's WebRTC ack/event-forwarding path for seconds at a time. All reads now use `fs.promises`, with ENOENT-tolerant directory walks. Also drops the unused `derivedTitle` field from `listAll` results (the UI consumers were removed earlier) so listing no longer reads any transcript content.
