---
"@coclaw/openclaw-coclaw": patch
---

fix(file-manager): reject late binary chunks that arrive after an upload's `done` frame so out-of-bounds bytes can no longer be absorbed into the written file.
