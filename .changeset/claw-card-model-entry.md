---
"@coclaw/ui": patch
---

Rework the claw card model entry. The current default model is now shown as a clickable row that opens the model-config page (provider and model on two truncated lines, or a quiet CTA when no primary model is set), and the rename / remove / manage-model actions fold into a three-dot menu so the card sheds its always-visible pencil, gear, and red unbind button. The orange guidance bar stays as a pure warning — its now-redundant inline link is removed. A shared `parseModelId` helper unifies the model-id parsing previously duplicated in the picker and model-config page. Channel status keeps its place in the metadata row, now with a wrap fallback so many channels no longer risk overflowing the card on narrow screens.
