---
'@coclaw/openclaw-coclaw': patch
---

Make `bindOk` / `unbindOk` message helpers tolerate missing/undefined data
so the `coclaw bind` / `coclaw unbind` CLI no longer crashes if the
`callGatewayMethod` helper falls back to its "non-JSON stdout" branch
(returning `{ ok: true }` without a payload). In that fallback the CLI
now prints `OK. Claw (unknown) bound to CoClaw.` / `OK. Claw (unknown)
unbound from CoClaw.` instead of throwing `TypeError: Cannot destructure
property 'clawId' of undefined`.

Behavior on the normal JSON path is unchanged.
