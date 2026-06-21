---
"@coclaw/openclaw-coclaw": patch
---

Fix the inline-key empty-id guard so a provider name normalizing to an empty id no longer falsely matches an inline credential node, align version comparison to strip `+` build metadata before `-` prerelease, and bump the `engines.node` floor to 20.11 to match the actual runtime requirement.
