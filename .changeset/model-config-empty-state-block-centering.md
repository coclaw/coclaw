---
"@coclaw/ui": patch
---

Center model-config empty-state text as a block instead of per line. The empty and starting placeholders in the model-config dialogs used `text-center`, which centers each wrapped line on its own and leaves a ragged left edge on narrow screens. Switch them to flex-based block centering so a short message stays centered while text that wraps falls back to left-aligned lines. Affects the primary-model picker empty state, the add-provider "no providers" empty state, the OAuth "requesting authorization" state, and the provider-list empty state on the model-config page.
