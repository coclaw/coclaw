---
'@coclaw/ui': patch
---

Round 2 hardening for cancel coordination heuristic fallback:
- Wrap `settleByCancel` + notify + i18n calls in `gone` and `not-supported` branches with try/catch so a thrown notify (e.g., future i18n strict mode or toast impl regression) cannot leave the coordination promise hanging.
- Soften `chat.cancelGoneHint` wording across all 12 locales: replace the implicit auto-appear promise ("the result will appear later") with a check-back-later phrasing that better reflects actual UI behavior (no automatic refresh after settle).
