---
"@coclaw/ui": patch
---

Polish the account-authorization (device-code) screen: trim the instruction to one generic line (the dialog title already names the provider), show the authorization code first (the usual first step is to copy it) above the link, drop the redundant "open authorization page" button (the URL is already a clickable link), and render the code as a compact inline box with an icon copy button (styled like the user-info copy-login-name button) that shows an inline "copied" hint for ~3s instead of a toast. The code is hidden when it is already embedded in the verification URL (e.g. minimax-portal). Updates all 12 locales and tests.
