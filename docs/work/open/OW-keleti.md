---
labels: [defect]
---

# A live view whose handle the server let go, renamed as well while this tab's stream was down, stays in the browser's state

Found 2026-09-25 by the implementer of OW-kimaya, after its review round; confirmed by reading `src/client/session-state.ts`, not reproduced.
In service of D21's reconnect gap being closed for every case D24 says it is, and of the browser holding no view of a session the server let go.

## What happens

Since OW-kimaya the reducer keys live views by handle, and `withoutOtherViewsOf` in the `snapshot` arm of `reduceServerEvent` drops any other view carrying the snapshot's ref, because the server maps each name to one handle.
`replaceSessionSummaries` evicts a view only when a listed summary pairs with it by ref and says `detached`.
Neither catches this sequence: this tab holds R's view under handle H1; while its stream is down, another client detaches R and attaches it again, so the server mints H2, and the session is then renamed to R2, as a first prompt on a virtual session does (D9).
On reconnect the opening snapshot carries H2 with R2, so it drops no view of R, and the re-list lists R2 under H2 and does not list R at all, since `list()` skips the names a container outgrew.
H1's view of R stays, and if R was selected, `handleOf(state, R)` answers H1 and the pane shows the frozen transcript.
On `main` before OW-kimaya the same ref-keyed view went stale the same way, so this is not a regression, but D21 and D24 now say the gap is closed, and for this combination it is not.

A related loss, noticed in the same review: per-tab state in `src/client/App.svelte` (the badge's turn watch, follow, remembered scroll) that sits under a handle the server let go is moved onto the new handle only for the selected session, by the switch effect's same-ref rule. A session that is not selected and is re-attached elsewhere leaves its turn watch under the dead handle, so a turn this tab submitted there no longer badges.

## A direction, not a prescription

The listing is authoritative about which handles are live: `list()` puts a `handle` on every summary whose container is in the table.
A view whose handle no summary in a fresh listing carries names a session the server let go, and could be evicted by `replaceSessionSummaries` under the same OW-fihuma rule as today (a view an event has touched since the listing was asked for is newer and stays).
Whether that is the right owner, and whether it also moves the unselected per-tab state, is for the executor to decide against `replaceSessionSummaries`'s docblock.

## Done when

A reducer test in `src/client/session-state.test.ts`, red first against the reducer as OW-kimaya left it: a view of R under H1, an opening snapshot under H2 carrying R2, a re-list listing R2 attached under H2 and not R, and then `viewOf(state, R)` is undefined and `state.sessions` holds H2 alone.
The D21 and D24 sentences in `docs/DESIGN.md` about the reconnect gap stay true as written after the fix, or are corrected in the same change.
`bun run check` green.
