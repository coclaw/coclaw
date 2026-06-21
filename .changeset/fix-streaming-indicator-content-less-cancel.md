---
"@coclaw/ui": patch
---

Fix a stuck "streaming" indicator on an empty assistant bubble. When a run reaches its terminal state, the streaming placeholder flags are now cleared directly, so the spinner stops even if the follow-up message reload fails to drop the placeholder. This removes the stuck spinner seen when cancelling a reply before its first token, and the lingering "thinking" spinner left when a post-run message reload fails.
