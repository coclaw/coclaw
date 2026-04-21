---
'@coclaw/openclaw-coclaw': patch
---

Stop shipping `src/homedir-mock.helper.js` in the published npm tarball. The file is a test-only helper referenced exclusively by `*.test.js` and was leaking into the published package as dead code. Added as an explicit entry alongside the existing `!src/mock-server.helper.js` exclusion. No runtime behavior change.

Explicit per-file exclusion is intentional — business modules may legitimately use the `.helper.js` suffix in the future, so a broad `!src/**/*.helper.js` glob would risk silently dropping them from the tarball.
