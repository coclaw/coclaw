---
'@coclaw/openclaw-coclaw': patch
---

chore(plugin/webrtc): drop unused `chunkAndSend` helper

`chunkAndSend` was a thin wrapper around `buildChunks` + `dc.send` used
before the application-layer flow control sender (`RpcDcSender`) landed.
After the FBQ/MemoryQueue refactor, no production path calls it; only
its own unit tests and a few integration tests in the same file
referenced it.

Removing the helper closes a latent foot-gun: future callers could pull
in `chunkAndSend` and accidentally bypass the queue's flow control,
overflowing the DataChannel send buffer. The integration tests are
preserved by switching them to a local `sendChunked` test helper that
composes `buildChunks` + `dc.send` directly.
