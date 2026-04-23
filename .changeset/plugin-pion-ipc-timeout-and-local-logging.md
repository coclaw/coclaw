---
"@coclaw/openclaw-coclaw": patch
---

Raise pion-ipc request timeout from 10s to 20s and stream pion-node internal logs to the plugin's local logger in addition to `remoteLog`. Severe events (IPC `request timeout` and `orphan response`) are logged at `error` level locally so operators can spot them immediately during on-host debugging; other messages go to `info`. Also renames the preloader option `startTimeout` to `ipcRequestTimeout` (same value controls both the startup ping and every subsequent IPC request, so the old name was misleading).

Motivation: a production incident on 0.17.3 surfaced a `dc.send` IPC timeout whose details were only visible server-side via `remoteLog`, making local diagnosis difficult. The longer window provides a safety margin against rare process-wide stalls without changing any IPC semantics.
