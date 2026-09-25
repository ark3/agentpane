---
labels: [change, d24]
blocked-by: [OW-nikogo]
closed: done
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

A handle: an opaque string, unique for the server's lifetime, minted when a container comes into being, in `createVirtual`, in `#start` for a stored session and for a parked fork's container at its attach, and in the "fork" branch of the identity-event handler for the container a Pi fork moves onto.
Mint it from a counter of the manager's own, not `deps.newId`: `src/server/http/vertical-slice.test.ts` injects a `newId` that returns one constant.
`#sessions` and `Broadcaster.#seq` key by handle, and `#pendingRequests` maps a request to the handle of the container blocked on it.
`#pendingForks` holds no container and stays keyed by the fork's backend key: a parked fork has no container until its attach, nothing is emitted for it before then and `ForkResponse` carries a ref only, so a handle minted at park time could be observed by nothing (amended 2026-09-25 after the cold read; D24's "a parked fork gets its handle when parked" is amended to match).
The container carries `names`, the set of `sessionKey`s that have named this conversation: the minted `virtual:` id, every id a "rename" brought, and every spelling `#start` canonicalised (OW-fumegi); `#lookup(ref)` resolves a ref through one map from name to handle, which is what `#aliases` becomes.
A "rename" adds a name and writes `ref`; a "fork" starts a new container with a new handle and the fork's id as its only name, and takes the parent's container out of the table with every one of its names, as the parent leaves the table today: detached in D9's and D12's sense, so a route on the parent's ref misses and the next attach of it resumes it from the index into a container of its own (D24, "a route on the parent's ref misses from the event on, as on any detached parent"; OW-kekoji's "leaves the parent detached rather than aliased onto the fork").
The parent's object keeps its names and `stored` and loses its adapter, so a verb that took it before the fork finds no adapter when it runs.
The fork's container takes the adapter, its `subscriptions`, `requests`, `notices` and `last*` mirrors, and the parent's pending requests, and starts with `error` null, no `stored`, `onDisk` false and a fresh `queue`, which is what the re-keyed object carries today; the adapter's handlers must reach whichever container is current, not the one `#start` bound them to.
`#disposing` guards an attach after a container is gone and may stay keyed by backend key.
`#attaching` may too for a stored session's index lookup, before any container exists, but once a container exists a `close()` or an attach under any name it has, including one a rename inside `start()` just added, must find the startup: key it by handle from then on, or carry the startup on the container, and `attach`'s `finally` stops walking the table for its own record.
What is load-bearing is that no map holding a container, or a startup a container can be reached by, is keyed by a name.
`SessionSummary` gains `handle`, present for a session the manager holds, virtual or attached, and absent for one only the index knows.
Every per-session arm of `ServerEvent` gains `handle` beside `session`, `renamed` included.
`AgentRequest` does not: the adapters build it and cannot know the handle, and the `request` event and the snapshot that hold one already carry the handle beside it.
`handle` is optional on both `SessionSummary` and the events in this card, so no hand-written event literal in a client test changes; OW-kimaya, the first card to read it, makes it required on the events.
`renamed` stays on both wires, emitted as it is today, until OW-mofuho removes it, so that both clients keep working across the gap.
The helper passes `handle` through on every per-session notification in `src/emacs/protocol.ts`, taking it from the event it is answering or, for what `sessions/attach` synthesizes, from the summary, and accepts it beside `session` on every request without forwarding it into an HTTP body (`sessions/prompt` and `sessions/fork` spread their params there); its `attached` set and its reads of the shared reducer are unchanged here and move with OW-kimaya.
Both frozen-interface notes, D11's in `src/shared/protocol.ts` and OW-mutufa's in `src/emacs/protocol.ts`, are amended to cite D24, and the latter's per-notification field lists name `handle`.

Load-bearing:

- The fork and rename split of OW-kekoji, OW-suhoto and OW-sehaja is unchanged in effect: a Pi parent's names never reach the fork's container.
- A verb queued on a Pi parent behind a fork of it does not run on the fork.
  OW-sewewe's `#serially` in `src/server/http/session-manager.ts` takes the container and its adapter when the verb is called, so as of OW-sewewe such a verb runs on the fork, which is what the fork's split from a rename forbids; its docblock names this card as the owner.
  Under a handle the queue stays with the parent's container, which keeps no adapter, so the verb takes the adapter when it runs and fails as a call on a detached session does.
- `#pendingRequests` keyed by handle still follows the container on a fork (the paragraph on the container in `ManagedSession`'s docblock, OW-bipume).
- A parked Codex fork holding a borrowed connection (OW-lajehi) and a parked Claude Code recipe (OW-razoki) each get their handle when their attach builds the container, and `close()` on the fork's ref still reaches the parked entry by its backend key.
- `attach` on any name a container has had, including one a rename left behind, still resolves to it, which is D9's promise that the old id keeps working on REST routes; the routes keep their `:backend/:id` shape.
- A handle resolves to one fixed backend for its life; OW-bakosi relies on a rename never changing `backend`.
- Teardown stops an event-driven re-key exactly as OW-nikogo left it: `close()` and `disposeAll()` drop the container's `subscriptions` in the same synchronous run that takes it out of the table, and `ManagedSession.torndown` is gone (the docblock on `ManagedSession.subscriptions`).
- OW-nikogo left one wait this card retires: a rename an adapter announces inside `start()` is held in `renamedInStart`, a variable local to `#start`, and applied only after `bound.adapter = adapter`, because `#attaching` holds a startup under the requested and canonical keys alone (the comment beginning "Publish the adapter *before* the rename below").
  Until then the adapter's ref runs ahead of the container's key, and what it emits during start -- Claude's `attachProcess` and `readSettings` after `moveTo(minted)`, for one -- goes out under the `virtual:` key; harmless today, since nobody can name the new id and `renamed` and a snapshot follow at publish, and OW-nikogo's adversarial read named it as the case that wait misses.
  Under a handle the rename is an attribute write, so the wait and `renamedInStart` go, and the tests under "a rename announced inside start()" in `session-manager.test.ts` are rewritten to what the handle makes true: a `close()` or an attach under the new name during start finds the one startup, and what the adapter emits during start goes out under the new ref.
  Two things of the wait stay, and neither is a key.
  A start that fails after renaming undoes the rename -- restores `ref` and drops the names the start added -- because a virtual container outlives the failure and a retry would otherwise resume an id its adapter never stored.
  And the `renamed` event for a rename inside `start()` goes out at publish, not at the write, so that "leaves no rename, no alias and no `renamed` behind when start() then fails" stays true on the wire; that hold is on the wire alone and leaves with `renamed` in OW-mofuho.
- D12's bookkeeping constraint is rewritten in `docs/DESIGN.md` to say a side map keyed by handle is safe, and OW-33's copy is amended to match.
- D21's reconnect gap narrows, and D24 says so: a `renamed` missed while the stream was down no longer strands a view once the clients key by handle (OW-kimaya, OW-danifa), since the opening snapshot under the handle carries the current ref; until they land it still does.

Incidental: the handle's format; whether `handle` on `SessionSummary` is optional or nullable; how a handle-bearing summary reaches a client that did not attach, given that `sessions-changed` fires at every turn boundary (OW-dinuwu) and the reconnect re-lists (D21).

## Done when

- Tests in `src/server/http/session-manager.test.ts`, red first: a container renamed twice is reachable by all three names and holds one handle throughout; a Pi-style fork gives the fork a new handle with none of the parent's names and leaves no name of the parent resolving to either container; a spelling alias from `#start` becomes a name on the container; a closed container is reachable by no name; a `setModel` or `submit` on a Pi parent's ref, queued behind that parent's fork, never reaches the fork's adapter and rejects as `UnknownSessionError`, red against today's `#serially`, which OW-sewewe's `["fork", "setModel"]` case shows running it on the fork.
- A test in `src/server/http/broadcaster.test.ts` that `snapshot`, `upsert`, `status`, `request`, `request-resolved`, `error` and `notice` each carry the handle, that `sendOpeningSnapshots` carries it, and that the seq is continuous across a rename with `renamed()` copying nothing.
- A test in `src/emacs/helper.test.ts` that every notification carries `handle` and that `sessions/attach` answers a summary carrying it.
- The rename and fork suites named in OW-nikogo stay green, save two cases this card's queued-verb rule changes by design and rewrites to keep what each guards: OW-zovaye's "sends nothing the second fork emits under the first fork's ref, while it is in flight", whose second `fork(REF)` now rejects, and OW-sewewe's `["fork", "setModel"]` ordering case, which moves to a fork mode that moves no ref.
  And `src/server/http/vertical-slice.test.ts` "leaves a browser that did not fork on the parent it was reading (OW-suhoto)" stays green.
- `docs/DESIGN.md` D9, D11 and D12 amended as D24 says -- D12's "The reaper must evict via the canonical ref" sentence as well as its bookkeeping constraint -- and D24's own sentences that describe the state before this card ("One point keeps its wait", "is where that wait dissolves", "runs on the fork until OW-suyinu", "a parked fork gets its handle when parked") rewritten to the landed state; `docs/WORKSTREAMS.md` "What the transport expects of its callers", and its Pi-adapter sentence "which re-keys through `#adoptRef`", updated where they describe re-keying.
- The comments that describe re-keying by ref, retired by this card, rewritten: the `ManagedSession` field docblocks, `#aliases`, `#pendingRequests`, `#attaching`, `#disposing`, `#serially`, `fork()`, `#adoptRef` and the `#start` comments in `session-manager.ts`; the class and `renamed` docblocks in `broadcaster.ts`; the "re-keys the session" sentence in `src/server/adapters/types.ts`; the re-key comments in `src/server/http/app.ts`; the helper's docblock and attach comment in `src/emacs/helper.ts`.
  Client comments such as `src/client/session-state.ts`'s rename arm stay, since the clients still key by ref until OW-kimaya.
- `bun run check` green.
- A cold read before execution, as OW-nikogo says; this is the larger of the two.

## Close note

Landed on `main` (8c554e1..d6dd5e0). `SessionManager` keys every live container by a handle it mints from its own counter (`h1`, `h2`, ...), keeps every backend id and `#start` spelling as `names` on it through one `#names` map (which replaced `#aliases`), and `Broadcaster.#seq` is keyed by handle. `handle` rides `SessionSummary` and every per-session `ServerEvent` arm as an optional field (OW-kimaya makes the events' field required), and every per-session helper notification; the helper strips a `handle` param before any HTTP body. `AgentRequest` gained none.

A rename writes `ref` and adds a name. A Pi fork (`#forkOnto`) makes a new container with a new handle, moving the adapter, subscriptions, requests, notices, `last*` mirrors, pending requests and the queue; the parent leaves the table with all its names and no adapter, so a verb queued on it behind the fork rejects with `UnknownSessionError` (`#serially` reads the adapter when the verb runs). `renamedInStart` is gone: a startup lives on its container as `starting`, `#attaching` keys only the spelling an attach asked for, a failed start restores `ref` and drops names it added, and only the `renamed` wire event of an in-start rename waits for publish. `#pendingForks` stays keyed by backend key, and `close()` discards parked entries under every name of the container.

The cold read before execution amended this card (commit 4b2f49f): the parent leaves the table rather than staying detached in it, `#pendingForks` gets no handle at park time, and `AgentRequest` gets no handle. The adversarial read caught one regression, fixed before landing: the fork's container first got an empty queue, letting a verb on the fork's ref run during the fork's `set_model`/`get_messages` tail. That was the wrong owner, not a missing guard: the queue follows the adapter.

Verified with new tests in session-manager, broadcaster and helper test files, each shown red first against the old code or under mutation. The OW-nikogo rename and fork suites stay green except two cases rewritten by design (OW-zovaye's second concurrent fork now rejects; OW-sewewe's fork-then-setModel ordering uses a fork that moves no ref), and vertical-slice's OW-suhoto test stays green. `bun run check` passed on `main`: 54 files, 1402 tests. D9, D11, D12, D21, D24 and WORKSTREAMS were rewritten to the landed state, and OW-33's copy of the bookkeeping constraint was amended (f5a64a0). The review's two pre-existing teardown oddities were filed as OW-vodinu and OW-ganapi.
