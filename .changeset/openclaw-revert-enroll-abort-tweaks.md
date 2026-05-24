---
'@coclaw/openclaw-coclaw': patch
---

revert(plugin): roll back the two unreliable `activeEnrollAbort` tweaks

Two consecutive attempts (`defer assignment until enrollClaw resolves`,
then `restore early-set with catch-guarded cleanup`) were made to remove
a residue case where `activeEnrollAbort` stayed pointing at a dead
controller after `enrollClaw()` threw synchronously. The residue is
purely cosmetic — the next enroll's `cancelActiveEnroll` aborts a
controller nobody listens to, producing one extra info log line and
nothing else.

The first attempt weakened the concurrent-cancel contract; the second
was patch-on-patch. Per the rule "fix the timing problem at the root or
don't touch it", both are reverted and the enroll handlers go back to
the shape they had before this round. The relevant entry is added back
to `plugins/openclaw/TODO.md` with the accepted-noise framing and a
note that the proper fix is to let `enrollClaw` consume the signal —
which needs a wider CLI/gateway/server design discussion first.

Tests that were added to assert the two patched behaviors are also
removed; the corresponding `claimCodeDelayMs` mock-server option is
dropped since no other test uses it.
