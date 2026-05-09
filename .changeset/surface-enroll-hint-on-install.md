---
"@coclaw/openclaw-coclaw": patch
---

Surface `openclaw coclaw enroll` as the next step for fresh installs. The OpenClaw plugin manifest and the npm `description` now point users at the enroll command, and the gateway log emits a one-time hint (`[coclaw] not bound — run \`openclaw coclaw enroll\` to connect to CoClaw`) at register time when no binding token is present. Already-bound installs see no change.
