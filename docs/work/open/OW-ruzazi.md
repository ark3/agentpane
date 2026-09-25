---
labels: [deferral, emacs]
---

# The helper's live lookup treats a failed request as 'not live' and never retries, so one error strands a buffer the old synchronous ref-match would have moved

Found 2026-09-25 by the adversarial read of OW-gusaru, confirmed in a scratch probe under /tmp.
In that probe, `GET /api/sessions/:backend/:id/live` answered 500 once, for the simple case of another client re-attaching with no rename.
One lookup was made, the snapshot under the new handle and the later status were dropped, and the buffer stayed on the old handle.

`reconcile` in `src/emacs/helper.ts` catches every failure of `liveSummary` as null, the answer that means "nothing live carries this ref".
It runs again only when another snapshot arrives under a handle no attachment holds, which may never happen.
Before OW-gusaru, the helper moved this case synchronously by comparing refs, with no request that could fail.
A helper paired with a server process started before OW-gusaru hits the same path: that server answers `/live` with the router's generic 404.

Judged not worth blocking OW-gusaru on: the route is a read of an in-process table over loopback.
Fix it if version skew between the helper and a long-running server proves real.
Whatever the fix, keep 404 meaning "not live" distinct from a failed request, and keep what `reconcile`'s docblock says true.

Done when a test in `src/emacs/helper.test.ts` makes the live route fail once and then succeed, and the attachment moves.
It must go red first against the helper as OW-gusaru left it.
`bun run check` green.
