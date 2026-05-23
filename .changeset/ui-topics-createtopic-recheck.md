---
'@coclaw/ui': patch
---

fix(ui): drop local topic write when claw is unbound mid-createTopic

`topics.store.createTopic` would `await conn.request('coclaw.topics.create',
...)` then unconditionally write `this.byId[topicId]` with the captured
`clawId`. If the claw was unbound from another device while the request
was in flight, the SSE `claw.unbound` push synchronously cleared the
claw from `clawsStore.byId` and `removeByClaw` purged the claw's
existing topics — but the in-flight `createTopic` would still come back
and add a fresh entry pointing at a claw that no longer exists. That
record then rendered in `MainList` as a topic that errored on click.

After the await, re-check `clawsStore.byId[clawId]`; if the claw is
gone, return the `topicId` (the plugin-side JSON record is persistent
and rightful — it'll come back via `loadTopicsForClaw` the next time
the same claw is rebound) but skip the local UI write. No rollback RPC
to the plugin: the topic is real history.
