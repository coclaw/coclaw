---
'@coclaw/ui': minor
---

Replace the PC rebuild retry budget from "3-attempt inner loop + 5-round exponential backoff (~93s total)" with a "5-minute time window + fixed 10s cooldown + single build per attempt" model. Drops exponential backoff entirely and removes the `MAX_BACKOFF_RETRIES` export (in favor of new `RETRY_WINDOW_MS` / `RETRY_COOLDOWN_MS`).

The previous model exhausted its budget within ~93s, while real openclaw gateway restarts often take 1–3 minutes. Affected claws ended up flagged as `unreachable` and required a manual retry. The new window-based budget rides the entire restart period at a steady 10s cadence and only gives up after 5 minutes of continuous failure.

`__ensureRtc`'s back-to-back inner loop is collapsed to a single build to honor the fixed-cooldown intent (back-to-back builds were also a contributor to the offer storms observed during gateway restarts). The post-await gate recheck now covers both success and failure paths, preserving the original "loop-second-iteration breaks on gate flip" semantics. UI labels (`ManageClawsPage` / `ChatPage`) and i18n strings drop the obsolete `{n}/{max}` retry counter format.
