---
"@coclaw/ui": patch
---

Preserve the add-provider list scroll position when returning from a provider's configure screen. Step 1 now uses `v-show` instead of `v-if`, so it is hidden rather than destroyed on the way into Step 2 and the browser keeps the list's scrollTop; Step 2 stays `v-if` since it must unmount to tear down the in-flight OAuth login poller.
