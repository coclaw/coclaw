---
'@coclaw/openclaw-coclaw': patch
---

Fix: `coclaw.files.delete` now requires `force` to strictly equal boolean `true`. Previously `if (params?.force)` accepted any truthy value (string `"false"`, number `1`, an object, etc.); a misconfigured client could accidentally trigger non-empty directory recursive deletion.
