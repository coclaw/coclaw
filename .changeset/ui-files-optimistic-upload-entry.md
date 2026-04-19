---
'@coclaw/ui': patch
---

fix(ui): keep uploaded files visible in FileManagerPage the moment transfer completes

Multi-file upload briefly lost freshly-uploaded files from the listing
right after each transfer finished. Cause: the "uploading" placeholder
was removed the instant the task flipped to `done`, while the real entry
only appeared after the next `loadDir` round-trip (driven by a 500 ms
poll). The poll window + RPC latency produced a noticeable gap where
the file existed on disk but showed up nowhere in the UI — worst on
file #1, intermittent on later files depending on poll phase.

Switch to optimistic insertion: `enqueueUploads` now takes an optional
`onDone` callback, fired on successful upload; `FileManagerPage` injects
the just-uploaded file into its `entries` array (and `dirCache`) in the
same synchronous tick that drops the placeholder. No more poll timer,
no more `loadDir` round-trip after each file. Manual refresh and
directory navigation still re-reconcile against the server.

`beforeUnmount` also unbinds the instance-scoped `onDone` from any
still-running tasks so that an in-flight large upload does not keep the
unmounted component alive.
