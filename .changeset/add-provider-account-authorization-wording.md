---
"@coclaw/ui": patch
---

Unify add-provider OAuth wording to "account authorization" and hide the unsupported callback method. When a provider offers both device-code and callback (oauth-login) auth, the callback entry is now hidden (we don't support it yet), so providers like openai-codex collapse to API key + account authorization. Both OAuth entries share the same "account authorization" label (they never appear side by side), the in-flow code is now called an "authorization code", and the unsupported-method hint no longer points users to a non-existent code option.
