---
labels: [change, d24, browser-testing]
blocked-by: [OW-suyinu]
closed: done
---

# The shared reducer and the browser key a live view by its handle, so no client code tracks a rename

Filed 2026-09-24 under D24 in `docs/DESIGN.md`; blocked by OW-suyinu, which puts the handle on the wire.
In service of the browser holding no map a backend rename can strand.

## What happens today

`ClientState.sessions` in `src/client/session-state.ts` is keyed by `sessionKey(ref)`, and the `renamed` arm deletes the old key, writes the new one, and moves `selected` and the matching summary.
`src/client/controller.ts` carries six rename-tracking closures, each a `const onRename` added to `renameListeners` for the life of one request: in `refreshForkPoints` (OW-lizohe), `setModel`, `setEffort`, `submit`, `forkAndSubmit` and `compact` (OW-natiha).
`recoveries`, `detaching`, `forkPointsInFlight`, `pendingModelSets` and `pendingEffortSets` there are keyed by `sessionKey`, and OW-sugome's close note says `recoveries` goes stale across a rename.
`src/client/App.svelte` re-keys its per-tab follow-mode and turn-watch maps in `rekeySession` from `controller.onRename(...)` (OW-mifuki), and `sessionLabel`, through `firstUserText`, looks a summary's live view up by `sessionKey(summary.ref)` (OW-46); `src/client/favicon.ts` `watchRename` carries the finished-turn marker across a rename (OW-webaho, OW-diyuwu), pinned by `src/client/favicon.test.ts`.
`send()` in `App.svelte` also calls `rekeySession(armedKey, sessionKey(landed))` after `forkAndSubmit`, moving the arming from the parent onto the fork, which no rename announces (OW-suhoto).
The helper, `src/emacs/helper.ts`, reads the same reducer, `state.sessions[key]`, and keeps an `attached` set of `sessionKey`s it re-keys on `renamed`.

## What this card does

The reducer keys `sessions` by handle; any arm under a handle updates the view's `ref` from the event's `session` as an ordinary attribute, and the `renamed` arm becomes a no-op kept only until OW-mofuho removes the event.
`selected` stays a `SessionRef`, the row the user chose, previews included, and a live view is found from a summary or a selection through its handle; how the controller pairs the two is incidental.
The six closures, `renameListeners` and `onRename` on `AgentpaneController` go, with the stubs of it in the App tests; the controller's five `sessionKey`-keyed sets and maps key by handle; `App.svelte`'s per-tab maps and `firstUserText`, and `favicon.ts`, key by handle.
What survives is the fork's move: every fork gets a new handle (D24), so `send()` still moves the arming from the parent's handle to the fork's, and `rekeySession` and the favicon's move function stay for that one caller while both `controller.onRename` subscriptions that drove them go.
OW-suyinu lands `handle` optional on the events, so that no client test literal changes there; this card, the first to read it, makes it required on every per-session `ServerEvent` arm and updates the literals.
The helper's reducer reads and its `attached` set move to the handle in the same change, since they consume the same module; its wire to Emacs is unchanged, and `session/renamed` still goes out until OW-mofuho.

Load-bearing:

- The badge and follow arming still end on the session the prompt landed on (OW-mifuki, D17); under a handle a rename never moves them, which is the point, and the tests that pinned the carry across a rename pin that instead, while a fork still moves them onto the fork's handle.
- `replaceSessionSummaries` still evicts a live view whose summary says detached and still guards a newer snapshot against an older listing (OW-fihuma).
- The non-creating arms of `reduceServerEvent` stay non-creating (OW-pezazo), and `snapshot` is still how a view is introduced.
- `applyAttached(…, false, …)` moving `selected` onto the returned ref (OW-yasewo) is decided one way or the other and recorded at the call site.
- OW-pehoba, the client's hard-coded `virtual:` prefix, is either closed by what the summary now carries or amended to say why not.
  The cold read found its premise already gone: since OW-wedupe `detach()` reads `SessionSummary.onDisk`, and its comment says "Not the `virtual:` prefix"; the dispatching session closes it.

## Settled by the cold read, 2026-09-25

- **`selected` follows the ref.**
  An event under a handle whose `session` differs from that view's `ref` rewrites the view's `ref`, the `ref` of the summary carrying that handle, and `selected` where it named the old ref.
  `detach()` finds the `onDisk` summary by ref and previews through the store by ref, where an old `virtual:` id reads an empty transcript (OW-vasubu); `aria-pressed` and `selectedSummary` compare refs too.
  REST calls would survive a stale ref, since every old name resolves on the server (`ManagedSession.names`); nothing else does.
- **A ref finds its handle** through the view carrying that ref, else the summary carrying it; the summary is the only holder in the window after `applyAttached` and before the snapshot. Whether that is a helper or an index is incidental.
- **What has no handle keeps a ref key.** Previews and stored rows never have one, and a summary re-listed after a close has none (`list()` adds it only for a container in the table).
  So the eviction and the OW-fihuma guard in `replaceSessionSummaries`, and `detach()`'s `listed` lookup, pair by ref; `App.svelte`'s per-tab maps key by the handle where there is one and by `sessionKey(ref)` where there is not, so `foldSessionTurns` still badges live rows while a preview is selected; the `{#each}` key over summaries stays `sessionKey(summary.ref)`.
- **A stored session attached from its preview is not a session switch.** Its key moves from the ref to the handle, and the `lastScrollKey` effect must not read that as a switch — no jump to the bottom, `editing` kept — as it does not today, where the key does not move; pin it with a test.
- **`ReduceResult.recover` carries the handle** beside the ref, so `recoveries` keys by it.
- **`setSessionCompaction` before the snapshot**, which today creates `emptySession(ref)`, is decided and recorded at the site: compact is enabled on `selected !== null`.
- **`applyAttached(…, false, …)`**: the cold read recommends keeping it and recording why at the call site — it moves the selection only when it already named the requested ref, and a click on a fork's own row mid-round-trip still needs it (OW-tatebi); the requested fork ref may have no handle yet, so the comparison stays by ref.
- **The helper** keeps its pending attaches keyed by the requested ref until the first event under a handle arrives, since it adds to `attached` before the REST call (D2) and has no handle then; it forwards `session/renamed` from the stream's `event.from`, checked before its `state === before` early return, since a no-op `renamed` arm would otherwise swallow it; and `sessions/detach` and `sessions/close` resolve the ref Emacs sends to a handle, since `emacs/agentpane.el` sends none.
- **Red first.** The ref-keyed code already passes `renamed` followed by a snapshot, the real wire order; what the handle fixes is the `renamed` that never arrived (a D21 reconnect, a late stream), so the rewritten tests stage a snapshot or status under the same handle carrying the new ref with no `renamed` before it.

## Done when

- The reducer test "re-keys selected state atomically on renamed" in `src/client/session-state.test.ts` is replaced by tests that a status under a known handle carrying a new `session` updates the view's `ref` and that selection survives, red against the ref-keyed reducer.
- The controller tests that stage a rename in `src/client/controller.test.ts`, "carries a pending set through a virtual session rename", "updates selection on renamed before a following snapshot", "clears the persisted error on the session's new key when a rename lands mid-submit (D9)", "clears the requesting mark on failure through a mid-flight rename (OW-natiha)" and "publishes fork points for a session renamed while the refresh was in flight (OW-lizohe)", are rewritten to assert the same outcomes with no rename tracking in the controller, each red against a controller that still keys by ref.
- `src/client/App.test.ts`'s OW-46 replay ("labels a just-prompted session by its own first user message while the server preview is still null"), "keeps following across a virtual session's rename on its first submit (D9: when attach named none)" and "a Pi-shaped fork ends on the renamed ref with the follow and scroll maps re-keyed (OW-hezidi)" rewritten to the handle; the last stages a `renamed` no fork sends since OW-suhoto, so it becomes a fork landing on a new handle.
- `src/client/favicon.test.ts`'s "follows a session renamed mid-turn (D9)" and `src/client/session-turns.test.ts`'s "carries both an observed stream and a finished mark across D9 rename" rewritten to the handle.
- `App.streaming-cost.test.ts`'s positive control still fires once its literals carry a handle, since a no-op upsert would pass its `calls === 0` without testing anything.
- `e2e/harness.ts` and `e2e/perf-harness.ts` carry the handle on their events and summaries, and `bun run test:browser` is run by hand and green, since the follow-mode arming in `App.svelte` is touched; `e2e/badge.spec.ts` stages no rename and may need no edit.
- The sentences that call the handle optional until this card, in `src/shared/protocol.ts`, `src/emacs/helper.ts` and D11 and D24 of `docs/DESIGN.md`, D21's reconnect-gap sentence, D17's "re-keyed onto the landed ref", and `docs/WORKSTREAMS.md` "What the transport expects of its callers" are rewritten to what landed; client docblocks describing re-keying by ref follow.
- `src/emacs/helper.test.ts`'s attach and rename tests stay green with the helper reading by handle.
- `bun run check` green.

## Close note

Landed on `main` (a799378..1494a90).
The shared reducer in `src/client/session-state.ts` keys `ClientState.sessions` by the handle the server mints, and an event under a handle carrying a new `session` rewrites the view's `ref`, the summary carrying the handle, and `selected` where it named the old ref (`followRef`); `handleOf`/`viewOf` find a view from a ref through the view, else the summary, which is the only holder between an attach reply and its snapshot.
The `renamed` arm is a no-op until OW-mofuho. `handle` is required on every per-session `ServerEvent` arm, and the attach reply is typed `LiveSessionSummary`, whose handle is required.
The controller's six rename closures, `renameListeners` and `onRename` are gone, and its per-session sets and maps key by handle; `ReduceResult.recover` carries the handle.
`App.svelte` keys per-tab state by `keyOf` (handle, else the ref for previews); `rekeySession` survives for a fork, which `forkAndSubmit` now resolves by the attach reply's handle, and for a key that moves under one selected ref (preview to attach, detach to preview, a re-attach elsewhere); `watchRename`/`renameSessionTurnMarks` became `watchMove`/`moveSessionTurnMarks`.
The Emacs helper keeps `attached` by handle with the ref last told Emacs, resolves `sessions/detach`/`close` through it, still forwards `session/renamed`, and moves an attachment onto a new handle whose snapshot brings a ref Emacs was told.

Two defects the adversarial read found were fixed before landing, both at the owner: the snapshot arm drops any other view carrying its ref (`withoutOtherViewsOf`), since the server maps each name to one handle, so a session re-attached elsewhere no longer leaves a frozen view in front of the live one; and `SessionManager` prefixes its handle counter with a per-manager random UUID, since a browser tab and the helper outlive a restart and a restarted server's `h1` moved the selection onto another session.
Decisions: `setSessionCompaction` marks only an existing view (compact before the snapshot shows the server's `compaction` once it lands); `applyAttached(…, false, …)` kept with its comparison by ref (OW-yasewo, OW-tatebi), recorded at both callers.

Verified: every named reducer, controller, App, favicon and session-turns test rewritten to stage the new ref on a status or snapshot under the same handle with no `renamed`, each shown red against the ref-keyed code by restoring HEAD files; the review fixes each shown red first (two managers both minted `h1`; the reducer held views h1 and h2 for R; the fork-arming App test read scrollTop 0 for 400). `bun run check` green on `main`: 54 files, 1412 tests; each intermediate commit checked. `bun run test:browser` green, 26/26, on the branch tree, whose `src`, `e2e`, `public` and `emacs` are identical to `main`'s.
OW-pehoba closed moot (OW-wedupe's `onDisk` had already retired the `virtual:` prefix). Filed: OW-wedeli (helper detach by a pre-rename ref, pre-existing) and OW-keleti (a dead handle's view that a rename hides from the snapshot, plus unselected per-tab state left under a dead handle).
