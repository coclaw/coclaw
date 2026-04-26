---
"@coclaw/ui": patch
---

fix(ui): topics __doLoadAll skips fulfilled results whose claw conn vanished mid-fetch

The first merge loop already preserves the old topics of any claw evicted
from `queriedClawIds` (sync conn-vanish or fetch failure or post-fetch
conn-vanish), but the second loop still walked every fulfilled result and
inserted its `topics`, so a claw whose conn vanished after the request
resolved would inject "ghost" topics into `byId` even though the claw is
gone from the store. Skip evicted-claw fulfilled results in the second
loop too, keeping the merge symmetric with the eviction set.
