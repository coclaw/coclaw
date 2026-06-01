---
"@coclaw/ui": patch
---

Show raw OpenClaw provider ids consistently across the model-config page. The API-key list and the remove-credential confirm dialog previously rendered hardcoded brand names (e.g. `DeepSeek`, `OpenAI`) while unmapped providers like `minimax-portal` fell back to their id, leaving a mixed id/name list. They now display the native provider id, matching the add-provider and primary-model pickers. Both pickers also sort by id instead of brand name, so the visible order matches the labels. The `displayName` map in `provider-meta.js` is kept (still carries `popular` / `dashboardUrl`) for a possible future brand-name surface, but is no longer consumed for display or sorting.
