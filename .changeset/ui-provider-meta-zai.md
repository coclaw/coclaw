---
"@coclaw/ui": patch
---

Fix Zhipu AI (GLM) missing from the "popular" group in the add-provider dialog. The popularity metadata was keyed by `zhipuai`, but OpenClaw's real provider id is `zai`, so it never matched the catalog and the provider fell into the "other" group. Key the entry by `zai`.
