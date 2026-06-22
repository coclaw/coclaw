---
"@coclaw/ui": patch
---

Stop emitting redundant `rpc.failed` remote-diagnostic logs for silent topic pre-persist loads. The connection layer gains an opt-in `quietCodes` request option so callers can declare tolerable failure codes (e.g. NOT_FOUND on a topic's first-send load) without suppressing diagnostics for real, user-initiated transcript loss.
