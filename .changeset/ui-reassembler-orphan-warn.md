---
"@coclaw/ui": patch
---

Add observability for DataChannel reassembler silent-drop branches: warn locally on every drop (orphan-chunk / short-frame / begin-overwrite / oversize), and emit a rate-limited remoteLog (5s window with suppressed counter) for orphan chunks — the branch a string→binary frame mistype lands on, so future similar incidents can be pinpointed within minutes instead of requiring deep investigation.
