---
'@coclaw/openclaw-coclaw': patch
---

Refactor: split rpc DataChannel send path into `MemoryQueue` (FBQ-API compatible in-memory buffer) + `RpcDcSender` (async blocking sender) + a consume loop. Behavior facing producers (`broadcast` / `sendTo` / files `sendFn`) is unchanged; the structural split makes the upcoming disk-spillover (FileBackedQueue) drop-in. Replaced the old `RpcSendQueue` and aligned admission, drop semantics, and overflow logging with the FBQ contract.

Stage 1 edge fixes shipped alongside the refactor:

- `RpcDcSender.__sendOne`: close the BAL-then-close race so a sender that wakes from `bufferedamountlow` finds the dc already `closing`/`closed` rejects with `SENDER_CLOSED` instead of throwing `InvalidStateError`.
- consumeLoop `finally`: identity-guard `session.rpcQueue === queue` before nulling the triple, so a stale loop from a previous DC instance can't wipe fields owned by the new instance after rebuild.
- DC rebuild: close the old `{ rpcChannel, rpcQueue, rpcDcSender, rpcConsumeLoop }` triple before installing the new one, and detach PC handlers earlier in `closeByConnId` to avoid handler firings against a torn-down session.
- `dc.onclose`: identity-guard against stale rebuild events so a delayed close from the previous DC can't null the new instance's fields.
- `dc.onbufferedamountlow`: bind to the local sender reference captured in closure, not `session.rpcDcSender`, so a rebuild between event registration and event fire doesn't dispatch BAL into the wrong sender.
- `pc.ondatachannel`: identity-guard against stale connId reuse — a queued ondatachannel from the old PC firing after detach used to install rpc/file channels onto the new session.
- `pc.onicegatheringstatechange`: detach in `closeByConnId` so the old PC's pending callback can't log against a freshly reused connId.
