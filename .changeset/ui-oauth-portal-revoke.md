---
'@coclaw/ui': minor
---

feat(ui): allow revoking CoClaw-managed scan-login (oauth) providers

OAuth credential rows were read-only ("一期 OAuth read-only"). Now a whitelist
of CoClaw-managed scan-login oauth providers (currently only `minimax-portal`)
gets the revoke button, while every other oauth provider (e.g. `openai-codex`,
which is configured outside CoClaw and cannot be re-logged-in from here) stays
read-only — avoiding a "log out but can't log back in" one-way trap.

Revoking reuses the existing remove flow (confirm dialog incl. the
primary-carrier strong warning) and the existing `coclaw.providerAuth.remove`
RPC, which for oauth simply deletes the credential — a clean logout. The
button/dialog wording is unchanged (shared "remove"/"撤销" text for all types).

The whitelist id must stay in sync with the plugin's `PORTAL_PROVIDER_ID`
(`minimax-portal`); a guard test pins this.
