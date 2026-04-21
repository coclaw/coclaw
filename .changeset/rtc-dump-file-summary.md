---
'@coclaw/openclaw-coclaw': patch
---

Shrink `rtc.dump` file channel summary on disconnect/failed.

`__dumpSessionState` previously concatenated `<label>=<readyState>` for every tracked file DC (up to the FIFO cap of 20). On long-lived PCs that accumulated many already-closed file transfers, the line grew to ~1KB and was duplicated into remoteLog. The dump now aggregates by `readyState`: closed channels collapse to a single count (`closed:N`), and only non-closed states list their labels (e.g. `open:1(file:abc)`). This keeps the diagnostic value — labels of DCs that failed to close cleanly — while bounding the line size regardless of session age.
