---
"@coclaw/ui": patch
---

Unify the default-primary-model row in the model-config page: effective, not-set, and invalid states now share one layout (content on the left, a single action button on the right) instead of three separate structures. The invalid state now also shows which model went stale (model name + warning together) rather than only a warning. The button carries two labels — "更换" when a primary is set (effective/invalid) and "配置" when none is set — and the two byte-identical open-picker handlers are merged into one. The unknown state (model.list RPC failed) keeps its placeholder with no button. Pure presentation change: the primaryState computation and the write/trustPrimary path are untouched.
