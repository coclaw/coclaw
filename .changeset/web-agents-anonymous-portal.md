---
'@coclaw/server': patch
'@coclaw/ui': patch
---

fix(web-agents): open the list to anonymous users and clear it on identity change

GET /api/v1/web-agents is now publicly accessible — anonymous callers receive
preset entries with personalized fields (lastClickedAt / hiddenAt) set to null.
click and hide endpoints stay behind auth.

On the UI side:
- recordClick / hide skip entirely when no user is signed in (opening a Web
  Agent acts purely as an external launcher, nothing is added to the sidebar).
- The webAgents store is now reset on explicit identity transitions — logout,
  login, register — so the anonymous snapshot loaded while browsing /about
  doesn't short-circuit MainList after signing in, and previously-clicked
  entries no longer linger after sign-out. refreshSession deliberately does
  not reset, since it runs concurrently with MainList's initial loadAll and
  shares the same cookie, so both observe a consistent auth view.
- loadAll guards against in-flight responses arriving after a reset; stale
  fetches no longer revive the just-cleared store.
