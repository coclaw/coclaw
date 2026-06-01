---
"@coclaw/ui": patch
---

Refine provider-auth / account-authorization wording across all locales: drop the misleading "API key" from the empty state (the panel also accepts account-authorization providers), soften the starting line to "requesting authorization" (de-emphasizing the "code" mechanic), unify the failure text to a single "authorization failed" wording, use a colon before the authorize link, shorten the over-long authorization-code labels (de/es/pt/en/fr) so the code row stays on one line on mobile, reword the timeout to "authorization timed out" (no longer naming the code), and fix the Korean method/flow terminology from 인증 (authentication) to 인가 (authorization) to match every other locale.
