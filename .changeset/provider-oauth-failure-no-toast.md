---
"@coclaw/ui": patch
---

Stop firing a toast when an account-authorization (OAuth) login fails or when the login channel is missing — the persistent inline error plus the footer retry/back actions already surface the failure, so the toast was redundant double feedback. Copy-code failures still toast (they have no inline feedback of their own).
