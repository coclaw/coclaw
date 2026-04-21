---
'@coclaw/openclaw-coclaw': patch
---

Exclude all `src/**/*.helper.js` files from the published npm tarball. Previously `package.json` only explicitly excluded `src/mock-server.helper.js`, so `src/homedir-mock.helper.js` (a test-only helper referenced only by `*.test.js`) leaked into the published package as dead code. The broader `!src/**/*.helper.js` glob covers both existing helpers and any future ones. No runtime behavior change.
