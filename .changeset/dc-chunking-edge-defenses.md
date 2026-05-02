---
'@coclaw/openclaw-coclaw': patch
---

Fix: add three edge defenses to dc-chunking. (1) Receiver rejects unknown flag bytes (non BEGIN/MIDDLE/END) so malformed frames cannot pollute the pending entry of the same msgId. (2) Receiver caps string frame length at 50MB to align with sender-side `MAX_REASSEMBLY_BYTES` and stop a peer from bypassing the cap. (3) `buildChunks` throws early when the math would produce more than `MAX_CHUNKS_PER_MSG` (10000) chunks, since under a tiny `maxMessageSize` the receiver would reject the trailing chunk and the message could never be reassembled.
