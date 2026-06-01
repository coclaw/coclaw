---
"@coclaw/ui": patch
---

Refine the account-authorization (device-code) login screen: collapse the copy button while the "copied" hint shows (no more icon-to-check swap, frees horizontal space on mobile), de-emphasize the authorization code by dropping its background and side padding (keeping only the highlight), add a spinner plus a little spacing to the "waiting for authorization" line, and surface the raw backend/channel error message under the localized error on failure (untranslated, for easier user-reported diagnosis).
