---
"@coclaw/ui": patch
---

Refine the primary-model picker empty state: drop the misleading "API key" wording (providers can also use account authorization) and add an "Add one" quick link that closes the picker and opens the add-provider dialog (one-way — it does not auto-return to the picker). The link renders text-sm with an underline to stand out, matching the /claws guidance "go configure" affordance.
