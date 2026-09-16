---
labels: [defect]
---

# D9 says a virtual session materialises on its first prompt; Pi has materialised at attach since 0.84.1, in ~23 places

The claim reads, in various wordings, "a virtual session materialises on its first prompt", and it is D9's design contract that every other copy is quoting.
Find the copies with `rg 'materialis|first prompt' src/ docs/` and discard the test files; roughly 23 non-test copies stand, about 16 of them in code.
The ones to read first, because they are the most confidently wrong or the most load-bearing:

- `docs/DESIGN.md` D9 holds four, and it is the authority the rest cite.
- `src/server/http/session-manager.ts` holds three, including `markPrompted`'s docblock: "Mark a virtual session as materialised. Called on the first prompt (D9)."
- `src/server/adapters/pi/process.ts` holds five, two of them beside state the adapter carries across a rename.
- `src/shared/protocol.ts` holds three, including the `SessionStatus` doc comment's `virtual` bullet and "nothing hits disk until the first prompt" on the create route.
- `src/client/App.svelte` four, `src/client/controller.ts` one in `detach()`'s virtual-exit docblock, `src/client/favicon.ts` one, `docs/WORKSTREAMS.md` one, and `docs/HANDOFF.md` two -- the two in HANDOFF are the *correct* ones and are the reason this card exists.

**This is a reconciliation card, not a discovery.**
`docs/HANDOFF.md` finding 41 measured the truth on `pi 0.84.1`: "Pi names its session file during `start()`, not on the first prompt … the id changes during **attach** and that second probe never fires", verified by a live `renamed` event observed before any prompt was sent.
A live run on 2026-09-16 re-confirmed it on `pi 0.85.1` and added the resume half -- no second `renamed` after a re-attach, because the id is already final (`docs/MANUAL_TESTING.md`, "`DELETE` then attach resumes a real Pi session", OW-jamoyi).
So the fact has been recorded and contradicted in the same repository for weeks, and the work here is retiring the copies that never heard, which is what `AGENTS.md`'s "the same change retires every copy" rule asks for.

**Do not delete the first-prompt path.**
Finding 41 says why and the caution is the load-bearing constraint on this card: a `virtual` session whose backend has not yet written a file is exactly what D9 describes, and Pi's startup write may be a property of how `pi --mode rpc` starts rather than a promise.
So this is a correction to what the comments claim, plus a decision about what D9 should say, and explicitly not a code removal.

Also unmeasured, and a boundary on how far the sweep may claim: attach-time materialisation is measured on **Pi only**.
Whether Codex and Claude Code materialise at attach is not known, so the shared copies in `src/shared/protocol.ts` and D9 must not be rewritten as if it were a property of all three.
That measurement is worth its own card if the sweep turns out to need it.

What is not yet known, and is why this is not a pure comment sweep: whether any site *depends* on the stale reading or merely describes it.
`detach()`'s virtual exit is the reassuring case -- its predicate `selected.id.startsWith("virtual:")` is still correct, since the id is `virtual:` exactly while nothing is on disk, and only its stated reason is wrong.
Confirm the same of the others rather than assuming it; a site that turns out to depend on it is its own defect and its own card.

Load-bearing: that attach, not the first prompt, is when Pi writes the file, and that finding 41 already says so.
Incidental: the wording each site lands on.

Done when `rg 'materialis|first prompt' src/ docs/` read through by hand leaves no copy asserting the false version, D9 says what is actually true and names the version it was measured on, and `bun run check` is green.
