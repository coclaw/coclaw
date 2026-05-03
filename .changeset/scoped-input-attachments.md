---
'@coclaw/ui': patch
---

Scope chat input attachments per chat/topic to prevent cross-context leak. Pending attachments now belong to the chat/topic store rather than the shared ChatInput instance, so switching to another chat/topic no longer shows the previous chat's attachments. New-topic sends `promote` to a fresh topic store with attachment references shared so users see no visual interruption while sending.
