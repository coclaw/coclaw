---
'@coclaw/openclaw-coclaw': patch
---

chore(plugin): drop verified low-risk TODOs; pin "why" notes at the source

After verifying nine fifth-tier TODO entries against current code, the
"keep" verdict still holds for all of them. To stop re-analyzing the
same items on every TODO pass, the entries are removed from `TODO.md`.
For six of them the "why we left it" reasoning is moved next to the
relevant code as a one-line comment (auth token console.warn fallback,
chat-history reload best-effort tolerance, bridge.start runtime-injection
assumption, topic copyTranscript orphan risk, chat-history sanitize
timestamp aliasing, classify nested cron+subagent reason).

For the remaining two entries (BIND_LOCAL_WRITE_FAILED shared code,
provider-auth CLI error mapping), the TODO is removed without code
comments — both are "improve when a caller actually needs it" deferrals
that would not benefit from in-source breadcrumbs.

The OpenClaw #80697 patch-script TODO is updated to reflect that the
upstream fix landed in `v2026.5.20`; upgrading OpenClaw is now the
recommended retirement path (no `--revert` needed since `npm install -g`
overwrites the patched dist).
