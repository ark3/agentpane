---
labels: [deferral]
---

# `close()` can dispose an adapter twice when a start publishes while it awaits a parked fork's dispose

Found 2026-09-25 by OW-suyinu's adversarial read; present on `main` before OW-suyinu too, so not a regression.
In service of every adapter being disposed exactly once, since a second `dispose()` on a Codex adapter holding a share of a borrowed app-server (OW-lajehi) is what could release a share twice.

`SessionManager.close()` in `src/server/http/session-manager.ts` reads `this.#lookup(ref)` first, then awaits the dispose of any parked fork's adapter (the block beginning "Before the `!session` return below"), and only then reads `session.starting`.
A `#start` that publishes its adapter during that await clears `starting`, so `close()` takes its other branch and calls `session.adapter?.dispose()`.
Where the parked entry's adapter and the starting one are the same object -- a parked Codex fork handle whose attach is in flight -- that adapter is disposed twice.
Since OW-suyinu `close()` gathers parked entries under every name of the container, which widens the set of calls that await here.

Judged not worth blocking on: no incident, and whether a second `dispose()` does harm depends on each adapter's idempotency, which nobody has checked.

Done when a test in `src/server/http/session-manager.test.ts` holds a parked Codex fork's attach mid-start (`FakeAdapterFactory` `holdStart`, `forkMode: "codex"`, `sharedChild`), closes the fork's ref, lets the start publish during the parked dispose, and asserts the adapter's dispose count is one -- red first against the current `close()`.
