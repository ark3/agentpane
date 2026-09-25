---
labels: [change, d24]
blocked-by: [OW-nikogo]
---

# The manager keys a live session by a handle it mints, keeps every backend id the session has had as names on the container, and carries the handle on the session summary and on every per-session event of both wires

Filed 2026-09-24 under D24 in `docs/DESIGN.md`, the second half of its identity commitment; read that decision first.
Blocked by OW-nikogo: the handler that re-keys on the adapter's event is where a rename becomes an attribute write.
In service of no map, on the server or in either client, being keyed by a name the backend can change.

## What happens today

Every table in `SessionManager` (`src/server/http/session-manager.ts`), `#sessions`, `#aliases`, `#pendingRequests`, `#attaching`, `#disposing` and `#pendingForks`, and `Broadcaster.#seq` in `src/server/http/broadcaster.ts`, is keyed by `sessionKey(ref)`, where `id` is whatever the backend calls the session.
D9 lists when that changes: at attach on every backend, at the first prompt on a Pi that named nothing at start, and at a Pi fork; OW-fumegi adds that a Pi path can be spelled two ways and `#start` canonicalises through the index, writing aliases for the spelling.
`#adoptRef` re-keys `#sessions` and `#pendingRequests` and retargets `#aliases`, `Broadcaster.renamed` carries the seq counter across, and `attach`'s `finally` walks `#attaching` looking for its own record because the key it was stored under may have moved.
D12's paragraph "Bookkeeping constraint (load-bearing)" exists only because of this: a stamp in a side map keyed by id would be stranded by the rename, so it must live on the object; OW-33 repeats it in the sentence beginning "Stamp recency/activity".
On the wire (`src/shared/protocol.ts`, D11) every event carries `session: SessionRef` and nothing else names the conversation, so a client's maps are keyed the same way and re-keyed by the `renamed` arm; the helper's JSON-RPC (`src/emacs/protocol.ts`) mirrors it with `session/renamed`, and `sessions/attach` in `src/emacs/helper.ts` synthesizes one for the three orderings OW-nuwive found, in which the attach reply names another ref and no rename reaches the stream.
OW-derewo's reverted first landing measures what keying by ref costs a client: per-session client maps needed about 140 lines and 15 race tests to stay right across renames.

## What this card does

A handle: an opaque string, unique for the server's lifetime, minted when a container comes into being, in `createVirtual`, in `#start` for a stored session and for a parked fork, and in the "fork" branch of the identity-event handler for the container a Pi fork moves onto.
`#sessions`, `#pendingRequests`, `#pendingForks` and `Broadcaster.#seq` key by handle.
The container carries `names`, the set of `sessionKey`s that have named this conversation: the minted `virtual:` id, every id a "rename" brought, and every spelling `#start` canonicalised (OW-fumegi); `#lookup(ref)` resolves a ref through one map from name to handle, which is what `#aliases` becomes.
A "rename" adds a name; a "fork" starts a new container with a new handle and the fork's id as its only name, and leaves the parent's container with its names, its `stored` summary and no adapter, detached (OW-kekoji, OW-suhoto, OW-sehaja).
`#attaching` and `#disposing` guard attaches before and after a container exists and may stay keyed by backend key; what is load-bearing is that no map holding a container is.
`SessionSummary` gains `handle`, present for a session the manager holds, virtual or attached, and absent for one only the index knows.
Every per-session arm of `ServerEvent` gains `handle` beside `session`, and `AgentRequest` too.
`renamed` stays on both wires, emitted as it is today, until OW-mofuho removes it, so that both clients keep working across the gap.
The helper passes `handle` through on every notification in `src/emacs/protocol.ts` and accepts it beside `session` on every request; its `attached` set and its reads of the shared reducer are unchanged here and move with OW-kimaya.
Both frozen-interface notes, D11's in `src/shared/protocol.ts` and OW-mutufa's in `src/emacs/protocol.ts`, are amended to cite D24.

Load-bearing:

- The fork and rename split of OW-kekoji, OW-suhoto and OW-sehaja is unchanged in effect: a Pi parent's names never reach the fork's container.
- `#pendingRequests` keyed by handle still follows the container on a fork (the paragraph on the container in `ManagedSession`'s docblock, OW-bipume).
- A parked Codex fork holding a borrowed connection (OW-lajehi) and a parked Claude Code recipe (OW-razoki) each get their handle when parked, and `close()` on the fork's ref still reaches the parked entry through its name.
- `attach` on any name a container has had, including one a rename left behind, still resolves to it, which is D9's promise that the old id keeps working on REST routes; the routes keep their `:backend/:id` shape.
- A handle resolves to one fixed backend for its life; OW-bakosi relies on a rename never changing `backend`.
- The teardown flags stop an event-driven re-key exactly as OW-nikogo left them.
- D12's bookkeeping constraint is rewritten in `docs/DESIGN.md` to say a side map keyed by handle is safe, and OW-33's copy is amended to match.
- D21's reconnect gap narrows, and D24 says so: a `renamed` missed while the stream was down no longer strands a view, since the opening snapshot under the handle carries the current ref.

Incidental: the handle's format; whether `handle` on `SessionSummary` is optional or nullable; how a handle-bearing summary reaches a client that did not attach, given that `sessions-changed` fires at every turn boundary (OW-dinuwu) and the reconnect re-lists (D21).

## Done when

- Tests in `src/server/http/session-manager.test.ts`, red first: a container renamed twice is reachable by all three names and holds one handle throughout; a Pi-style fork leaves the parent's handle without an adapter and gives the fork a new handle with none of the parent's names; a spelling alias from `#start` becomes a name on the container; a closed container is reachable by no name.
- A test in `src/server/http/broadcaster.test.ts` that `snapshot`, `upsert`, `status`, `request`, `request-resolved`, `error` and `notice` each carry the handle, that `sendOpeningSnapshots` carries it, and that the seq is continuous across a rename with `renamed()` copying nothing.
- A test in `src/emacs/helper.test.ts` that every notification carries `handle` and that `sessions/attach` answers a summary carrying it.
- The rename and fork suites named in OW-nikogo stay green, and `src/server/http/vertical-slice.test.ts` "leaves a browser that did not fork on the parent it was reading (OW-suhoto)" stays green.
- `docs/DESIGN.md` D9, D11 and D12 amended as D24 says, and `docs/WORKSTREAMS.md` "What the transport expects of its callers" updated where it describes re-keying.
- `bun run check` green.
- A cold read before execution, as OW-nikogo says; this is the larger of the two.
