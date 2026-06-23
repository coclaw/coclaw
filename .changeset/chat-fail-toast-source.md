---
"@coclaw/ui": patch
---

Chat failure toasts now prefix the source chat/topic name when the failed send/run belongs to a chat other than the one currently in view, so a failure that lands after you've switched chats is no longer mistaken for the current chat's failure. Failures for the chat you're still looking at stay unprefixed.
