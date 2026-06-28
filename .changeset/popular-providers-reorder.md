---
"@coclaw/ui": patch
---

Reorder the "Popular" providers group in the add-provider dialog. The popular group is now driven by an explicit ordered list (POPULAR_ORDER): DeepSeek, Zhipu (zai), MiniMax, MiniMax (Portal), Moonshot, Qwen, Volcengine, OpenAI, OpenRouter. Adds MiniMax, MiniMax (Portal), Qwen, Volcengine and OpenRouter to the popular group, and moves Anthropic and Google out of it (they remain available under the "Other" group). The other group keeps its alphabetical order; display still shows the native provider id.
