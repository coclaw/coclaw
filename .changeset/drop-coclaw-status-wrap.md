---
'@coclaw/openclaw-coclaw': patch
---

Drop the `{ status: <data> }` wrap on the 6 RPC methods that had a CLI entry
(`coclaw.bind` / `unbind` / `enroll` / `providerAuth.setApiKey` / `list` /
`remove`). Handlers now return business payload directly. The shared
`callGatewayMethod` helper changes from extracting `.status` to passing the
parsed wire payload through as a `payload` field, and the in-package CLI
registrar reads `result.payload.xxx` accordingly.

The `{ status: <data> }` form was never a protocol requirement — it was a
private convention of the helper's `.status` unwrap behavior, originally
introduced to satisfy the upstream `openclaw gateway call --json` rule that
the payload must be a non-undefined JSON object (otherwise `endsWith`
TypeError). Each of the 6 handlers now returns a plain non-empty object
(`{}` for the empty case), so the upstream constraint remains satisfied.

External behavior is unchanged:

- CLI users see the same stdout text and exit codes
- The only wire-form consumer of these 6 methods is the same-package CLI
  registrar (verified by repo-wide grep; server / UI / e2e / other plugins
  do not consume them)
- `coclaw.upgradeHealth` (used by the auto-upgrade worker) was never wrapped
  and is untouched; the worker's verification path is independent of the
  helper and not affected
