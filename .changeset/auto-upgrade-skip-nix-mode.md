---
'@coclaw/openclaw-coclaw': patch
---

Skip the auto-upgrade scheduler when the host is in OpenClaw Nix mode (`OPENCLAW_NIX_MODE=1`).

Starting with OpenClaw 2026.5, `openclaw plugins update|install|uninstall` calls `assertConfigWriteAllowedInCurrentMode()` and throws `NixModeConfigMutationError` (code `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE`) on Nix-managed installs, where `~/.openclaw/openclaw.json` is treated as an immutable Nix-built artifact. The plugin's auto-upgrade worker would have repeatedly invoked `openclaw plugins update <id>` on these hosts, generating noisy failures with no possibility of success (any runtime mutation gets reverted on the next Nix rebuild).

The scheduler now short-circuits at `start()` with an info log (`Skipping: host is in Nix mode (config is immutable)`) and a one-shot `upgrade.nix-mode-skip` remoteLog event so user-visible "auto-upgrade not running" reports can be correlated server-side without needing to ask the user about their install method. The Nix-mode probe is strict-equality with the string `"1"`, mirroring upstream's `resolveIsNixMode` semantics — `"true"`, `"yes"`, etc. are intentionally not honored.
