---
'@coclaw/openclaw-coclaw': patch
---

Drop the `node-datachannel` dependency and its `vendor/ndc-prebuilds/**` publish entry to shrink the npm tarball from ~50 MB to ~82 kB, removing the main source of auto-upgrade stalls on slow networks.

- Pion has been validated as the reliable primary WebRTC implementation; werift remains as the runtime fallback when pion fails to load.
- `src/webrtc/ndc-preloader.js` is deliberately left in place during this transition. With the package missing, `require.resolve('node-datachannel')` throws synchronously and the preloader's existing `try/catch` falls through to werift via the unchanged fallback path — no consumer ever reaches an ndc-only code path.
- No change to gateway RPC methods, plugin events, or binding protocol.
