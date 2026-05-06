---
'@coclaw/openclaw-coclaw': patch
---

Speed up the test-only mock HTTP helper by force-closing all keep-alive connections before `server.close()`. Without this, Node's `http.Server.close()` waits for every existing client connection to be terminated by the client side, and undici (Node's built-in fetch) keeps connections alive for a few seconds by default. The `coclaw.bind`/`coclaw.unbind` cancel-enroll test in particular dropped from ~13 s to ~70 ms after this change, and the overall plugin test suite is ~10 s faster. The helper itself is excluded from the published package (declared in `package.json` `files`), so this change has no production impact.
