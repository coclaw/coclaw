---
'@coclaw/openclaw-coclaw': patch
---

Fix: atomic-write tmp file is now fsync'd before rename, and parent dir is fsync'd after rename. Without these fsyncs, a system power loss between `writeFile` and `rename` could leave the renamed file with empty/stale content even though `rename` itself is atomic at the metadata layer. Affects device-identity and auto-upgrade state persistence which both go through this helper. Skip parent-dir fsync gracefully on Windows where dir fd is not supported.
