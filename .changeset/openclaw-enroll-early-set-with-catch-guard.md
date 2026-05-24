---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin): restore early-set `activeEnrollAbort` with catch-guarded cleanup

The previous round (defer assignment until `enrollClaw` resolves) fixed
the "abort controller residue when `enrollClaw` throws" issue but
weakened concurrent-cancel semantics: a second `enroll`/`bind`/`unbind`
arriving while the first `enrollClaw` was still in flight would not see
the first controller and could no longer cancel it, leaving two
`waitForClaimAndSave` loops co-existing.

This change restores the original early-set assignment so concurrent
entries can still cancel the in-flight enroll, and wraps `enrollClaw`
in an inner `try/catch` that clears `activeEnrollAbort` via an
identity guard (`activeEnrollAbort === ac`) when `enrollClaw`
throws — fixing the residue case without sacrificing the cancel
semantics. The identity guard mirrors the one already in the
`fire-and-forget waitForClaimAndSave` `.finally()` chain, so a second
enroll arriving and overwriting `activeEnrollAbort` cannot be
double-cleared.

A new red test exercises the concurrent path: two `coclaw.enroll`
invocations overlap inside the `enrollClaw` mock delay window, and
the second one is asserted to log `cancelling active enroll` for the
first controller. The existing "residue on throw" red test still
passes since the inner catch yields the same observable behavior.
