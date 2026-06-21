---
"@coclaw/server": patch
---

Guard `setHiddenNow` against a missing user id. Previously an undefined `userId` would let Prisma drop the filter on the `updateMany`, hiding the Web Agent for every user who had clicked it instead of only the current user. The repo helper now returns early (zero rows affected) when `userId` is not a bigint, so the service maps it to a 404 and no cross-user rows are touched.
