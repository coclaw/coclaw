---
"@coclaw/ui": patch
---

Surface the unsupported account-authorization (callback OAuth) method via a toast instead of a dead-end screen. Clicking a callback-only provider in the add list, or the callback entry in the method chooser, now shows a "not supported yet" notification and keeps the user where they are (provider list / chooser) — the list scroll position is preserved and a navigable dead-end substate is removed. The chooser entry label now carries a "(not supported yet)" suffix, and the unsupported message is neutral (no longer suggests an API key, which callback-only providers don't have). Updates all 12 locales and tests.
