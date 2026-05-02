---
'@coclaw/openclaw-coclaw': patch
---

Fix: rtc:offer handling now defensively validates `turnCreds.urls`. The original `for of urls` loop threw a TypeError when `urls` was missing and char-iterated when `urls` was a single string (producing malformed iceServers entries) — both broke offer handling or yielded a malformed PC config. After the fix, `urls` must be a string array; otherwise it's skipped with a warn and the PC continues negotiating with host-only candidates.
