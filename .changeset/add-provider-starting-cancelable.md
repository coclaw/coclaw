---
"@coclaw/ui": patch
---

Render the add-provider account-authorization step's footer Cancel action during the initial (starting) phase too, not only once the verification code arrives. This removes the empty-footer / top-heavy look while the phase-1 request is in flight, and lets the user cancel a slow phase-1 right away.
