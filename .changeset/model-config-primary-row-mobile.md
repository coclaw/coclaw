---
"@coclaw/ui": patch
---

Make the default-primary-model row mobile-friendly: the provider/model id now splits into two stacked lines (a dimmed provider on top, the model below), each truncated, so a long id no longer overflows or wraps raggedly on narrow screens, and the action button stays pinned to the right instead of wrapping below. Applies to the effective and invalid states (which carry a model name); not-set and unknown states are unchanged. Pure presentation — the primaryState computation and the write/trustPrimary path are untouched.
