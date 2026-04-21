---
'@coclaw/ui': patch
---

Fix silent image corruption on file downloads when `dc.close` races ahead of the final `{ok:true,bytes}` JSON.

`WebRtcConnection.createDataChannel` (the public entry point used for `file:<transferId>` DCs) was not setting `dc.binaryType`. The W3C WebRTC default is `'blob'`, which is what Firefox and Safari/WebKit use; Chromium has historically deviated but behavior across WebView versions is not guaranteed. Under `binaryType='blob'`, each incoming binary chunk in `file-transfer.js` was a `Blob` (which has `.size`, not `.byteLength`), so `receivedBytes += event.data.byteLength` accumulated `NaN` from the first chunk on.

On the happy path (`{ok:true,bytes}` JSON arrives before `dc.close` fires), downloads still appeared to succeed — `new Blob(chunks)` transparently concatenates a mixed array of Blobs. The bug only surfaced on the `onclose`-first race (acknowledged by existing defensive comments on both ends — `plugins/openclaw/src/file-manager/handler.js` explicitly `await dc.close()` for graceful semantics, and `file-transfer.js` adds a `setTimeout(0)` macrotask to let queued `message` events drain first). In that branch the fallback checks `receivedBytes >= totalSize`, which with `NaN` is always `false`, rejecting the transfer as `TRANSFER_INTERRUPTED` even though every byte had in fact arrived and `chunks` held a valid payload. Users see a broken image; remounting the component (navigate away + back) usually wins the race the second time. The race is more likely during ICE restart recovery, app foreground resume, long list renders, or any main-thread pressure — precisely the moments aggressive topic/chat cache + silent background reload triggers batch downloads, so the defect compounds.

Changes:

- `webrtc-connection.js`: set `dc.binaryType = 'arraybuffer'` immediately after creating the DC in `createDataChannel`, before returning (mirrors the rpc DC setup at the private `__setupDataChannelEvents` path). Async Blob construction is removed from the binary-message dispatch path, shrinking the race window as a side benefit.
- `file-transfer.js`: defensive `event.data.byteLength ?? event.data.size ?? 0` so that any future path which forgets to set `binaryType` cannot silently corrupt the byte counter.
- `webrtc-connection.test.js`: mock PeerConnection's `createDataChannel` now exposes `binaryType: 'blob'` as the default (matching spec), and a new assertion verifies the public API flips it to `'arraybuffer'`.
- `file-transfer.test.js`: new close/message race test where the binary chunk arrives as an actual `Blob` (no `byteLength`); the `onclose` fallback must still recognize the bytes are complete and resolve.

No protocol or wire-format change.
