---
'@coclaw/openclaw-coclaw': patch
---

Bump `@coclaw/pion-node` dependency from `^0.1.2` to `^0.1.3`.

The plugin's WebRTC layer (`webrtc-peer.js` — `__sendPeerTransport` /
`__logNominatedPair`) reads `selectedCandidatePair.local.relayProtocol`
to surface the plugin-side relay protocol for the `coclaw.rtc.peerTransport`
DC event and nominated-pair logs. This field is only populated starting
from pion-node 0.1.3 (which exposes pion-ipc's `RelayProtocol` passthrough
on the local candidate). Under 0.1.2 the field was always `undefined`, so
relay connections showed only the browser-side protocol in the UI. Pinning
the floor to 0.1.3 makes the behavior reliable.
