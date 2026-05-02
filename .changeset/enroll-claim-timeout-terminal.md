---
'@coclaw/openclaw-coclaw': patch
---

Fix: `waitForClaimAndSave` treats server `408 + CLAIM_TIMEOUT` as a terminal expired state and throws `claim code expired` immediately. Previously every non-404 error (including the server's own 408 expiration response) was treated as transient and retried, so a background enroll would keep polling every 2s after the claim code was permanently invalid and never release the `activeEnrollAbort` slot.
