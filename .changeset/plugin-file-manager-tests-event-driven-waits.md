---
'@coclaw/openclaw-coclaw': patch
---

Speed up the file-manager handler test suite by replacing ~80 fixed `setTimeout` sleeps with event-driven waits. The mock DataChannel now hooks `send()` to wake any pending wait whose predicate has become true, and a generic `waitFor(predicate)` helper polls at 1 ms intervals for cases without a `send` signal (filesystem state, `remoteLog` entries, exposed counters, etc.). Each former sleep is replaced with a predicate aligned to whatever the next assertion was about to check, so the test moves on the moment the SUT is actually ready instead of blocking for whichever round-number ms the original author guessed. Handler test file dropped from ~10.5 s to ~2.0 s (80% reduction); overall plugin suite ~9 s faster. A handful of negative-timing tests ("should not crash", race-prone tmp-file cleanup) intentionally retain a short fixed sleep where there is no positive signal to wait on. The handler implementation itself is not modified.
