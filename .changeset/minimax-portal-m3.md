---
"@coclaw/openclaw-coclaw": patch
---

Add MiniMax-M3 to the minimax-portal static model catalog (mirrors upstream's MINIMAX_TEXT_MODEL_ORDER). Existing bindings pick it up via the startup reconcile (config missing the M3 id is rewritten with the full table); new OAuth logins write all three. M3 carries its multimodal input flag (text + image) and the 1M context window.

Also: `getPortalModels` now deep-clones each entry (was a shallow `{ ...m }` that shared the M3 `input` array by reference with the static table), and the startup model-list reconcile now emits a local log + remoteLog of its decision (whether the portal model list needs injecting) and the injection itself, for diagnostics.
