---
"@coclaw/ui": patch
---

Rewrite `remoteLog` internals with a producer/consumer architecture: a single async consumer loop driven by an `AbortController`, and an array-based retry schedule (`RETRY_DELAYS = [1, 2, 4, 8, 16, 30, 30, 30, 30, 30]` seconds). No external API or singleton shape changes.

Retry-policy behavior change: removed the wall-clock `MAX_DURATION` upper bound (previously 10 minutes). Retry count is now driven solely by `RETRY_DELAYS.length`: 11 sends per batch (1 first + 10 retries), totaling ~181s of baseline backoff and ~300s when the server keeps responding `Retry-After: 30` (10 × 30s). The jitter on backoff was removed (different UI instances naturally stagger). `Retry-After` is now also parsed for 5xx responses (mainly 503) and capped at 30s (`Math.max(...RETRY_DELAYS)`). Mobile background freeze + foreground resume now keeps the batch in flight instead of dropping it on wall-clock timeout.

Two unrelated fixes folded in: `navigator.connection?.effectiveType` is now read with a `typeof navigator !== 'undefined'` guard (was throwing `ReferenceError` in non-browser environments), and abort detection inside the retry loop uses `signal.aborted` rather than matching `error.name` (axios v1 cancel raises `CanceledError` while `AbortSignal` raises `AbortError` — name matching would have missed the axios path).
