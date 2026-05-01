---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin): make rpc send queue a total function and correct single-msg cap accounting

- Catch `buildChunks` exception inside `RpcSendQueue.send` so a malformed peer SDP (`maxMessageSize <= header`) cannot crash the gateway.
- Compare `MAX_SINGLE_MSG_BYTES` against payload bytes instead of frame bytes (which include 5-byte chunk headers), so a payload at the 50 MB receiver cap is no longer falsely dropped.
- Wrap all `logger.*` and `remoteLog` calls in safe helpers and validate the input is a string, so `send`/`__drain`/`onBufferedAmountLow` are guaranteed not to throw under any input or downstream-logger fault.
- Remove the now-redundant `try/catch` around `q.send` in `webrtc-peer.broadcast`/`sendTo`/files `sendFn`, harden the three `JSON.stringify` call sites against cyclic/BigInt payloads, and propagate the `q.send` return value in `sendTo`.
