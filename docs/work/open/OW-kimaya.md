---
labels: [change, d24, browser-testing]
blocked-by: [OW-suyinu]
---

# The shared reducer and the browser key a live view by its handle, so no client code tracks a rename

Filed 2026-09-24 under D24 in `docs/DESIGN.md`; blocked by OW-suyinu, which puts the handle on the wire.
In service of the browser holding no map a backend rename can strand.

## What happens today

`ClientState.sessions` in `src/client/session-state.ts` is keyed by `sessionKey(ref)`, and the `renamed` arm deletes the old key, writes the new one, and moves `selected` and the matching summary.
`src/client/controller.ts` carries six rename-tracking closures, each a `const onRename` added to `renameListeners` for the life of one request: in `refreshForkPoints` (OW-lizohe), `setModel`, `setEffort`, `submit`, `forkAndSubmit` and `compact` (OW-natiha).
`recoveries` and `detaching` there are keyed by `sessionKey`, and OW-sugome's close note says `recoveries` goes stale across a rename.
`src/client/App.svelte` re-keys its per-tab follow-mode and turn-watch maps in `rekeySession` from `controller.onRename(...)` (OW-mifuki), and `sessionLabel` looks a summary's live view up by `sessionKey(summary.ref)` (OW-46); `src/client/favicon.ts` `watchRename` carries the finished-turn marker across a rename (OW-webaho, OW-diyuwu), pinned by `src/client/favicon.test.ts` and `e2e/badge.spec.ts`.
The helper, `src/emacs/helper.ts`, reads the same reducer, `state.sessions[key]`, and keeps an `attached` set of `sessionKey`s it re-keys on `renamed`.

## What this card does

The reducer keys `sessions` by handle; any arm under a handle updates the view's `ref` from the event's `session` as an ordinary attribute, and the `renamed` arm becomes a no-op kept only until OW-mofuho removes the event.
`selected` stays a `SessionRef`, the row the user chose, previews included, and a live view is found from a summary or a selection through its handle; how the controller pairs the two is incidental.
The six closures and `renameListeners` go; `recoveries` and `detaching` key by handle; `App.svelte`'s per-tab maps and `sessionLabel`, and `favicon.ts`, key by handle, and `watchRename` goes.
The helper's reducer reads and its `attached` set move to the handle in the same change, since they consume the same module; its wire to Emacs is unchanged, and `session/renamed` still goes out until OW-mofuho.

Load-bearing:

- The badge and follow arming still end on the session the prompt landed on (OW-mifuki, D17); under a handle they never moved, which is the point, and the tests that pinned the carry pin that instead.
- `replaceSessionSummaries` still evicts a live view whose summary says detached and still guards a newer snapshot against an older listing (OW-fihuma).
- The non-creating arms of `reduceServerEvent` stay non-creating (OW-pezazo), and `snapshot` is still how a view is introduced.
- `applyAttached(…, false, …)` moving `selected` onto the returned ref (OW-yasewo) is decided one way or the other and recorded at the call site.
- OW-pehoba, the client's hard-coded `virtual:` prefix, is either closed by what the summary now carries or amended to say why not.

## Done when

- The reducer test "re-keys selected state atomically on renamed" in `src/client/session-state.test.ts` is replaced by tests that a status under a known handle carrying a new `session` updates the view's `ref` and that selection survives, red against the ref-keyed reducer.
- The controller tests that stage a rename in `src/client/controller.test.ts`, "carries a pending set through a virtual session rename", "updates selection on renamed before a following snapshot", "clears the persisted error on the session's new key when a rename lands mid-submit (D9)", "clears the requesting mark on failure through a mid-flight rename (OW-natiha)" and "publishes fork points for a session renamed while the refresh was in flight (OW-lizohe)", are rewritten to assert the same outcomes with no rename tracking in the controller, each red against a controller that still keys by ref.
- `src/client/App.test.ts`'s OW-46 replay and `src/client/favicon.test.ts` rewritten to the handle.
- `bun run test:browser` run by hand and green, since `e2e/badge.spec.ts` and the follow-mode arming in `App.svelte` are touched.
- `src/emacs/helper.test.ts`'s attach and rename tests stay green with the helper reading by handle.
- `bun run check` green.
