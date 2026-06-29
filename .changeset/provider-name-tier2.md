---
"@coclaw/ui": patch
---

Show friendly provider brand names in the remaining raw-id spots: the default-model row, the claw card model row, and the primary-model picker group titles. The picker now also matches and sorts by brand name (raw id still searchable). Provider id remains the sole source of truth (testids/keys/RPC payloads unchanged); uncovered variants gracefully fall back to the raw id.
