---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin): no residue `activeEnrollAbort` when `enrollClaw` throws

Both the `coclaw.enroll` RPC handler and the slash `/coclaw enroll`
entry previously assigned the new `AbortController` to
`activeEnrollAbort` _before_ calling `enrollClaw()`. If `enrollClaw`
threw (network error, `ALREADY_BOUND`, invalid response), the
controller remained referenced even though no `waitForClaimAndSave`
loop ever started, so the next enroll would log a spurious
`cancelling active enroll` while cancelling a dead controller.

`enrollClaw` does not consume the signal — only `waitForClaimAndSave`
does — so the assignment is now deferred until after `enrollClaw`
resolves. When `enrollClaw` throws, `activeEnrollAbort` stays `null`
(as `cancelActiveEnroll()` already cleared it at the top of the
handler), and the next enroll proceeds with a clean slate.
