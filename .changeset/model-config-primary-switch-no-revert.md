---
"@coclaw/ui": patch
---

Fix model-config primary-model switch reverting to the old model after ~1-2s

After switching the default primary model, the page briefly showed the new model and then snapped back to the old one. Root cause: the post-write refresh re-read `coclaw.model.list` within ~1s of the write, hitting OpenClaw's not-yet-refreshed runtime config snapshot, and overwrote the page with the stale old value.

The switch path now treats a successful `model.set` as authoritative (success-is-authoritative, no re-read-to-confirm): it sets the new primary plus the credential signals directly and skips the `model.list` re-read on that path (`refreshAfterWrite({ trustPrimary })`). Add/remove-provider paths are unchanged — they still re-read and apply `model.list`, so removing the primary's carrier provider still correctly flips it to invalid.
