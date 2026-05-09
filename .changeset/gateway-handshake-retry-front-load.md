---
"@coclaw/openclaw-coclaw": patch
---

Front-load four short delays (`1s`, then three `1.5s`) in the gateway handshake retry table so the first retry happens well before the previous `5s` floor. This shortens recovery from the boot-time race where the gateway server replies `gateway starting; retry shortly` (`retryAfterMs=500`) on the very first connect; the second attempt now lands roughly a second after the failure instead of five. The original `5s/10s/20s/20s/20s` tail is preserved, so the budget grows from 5 to 9 retries (10 total attempts) before entering the gave-up state.
