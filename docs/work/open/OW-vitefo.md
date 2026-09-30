---
labels: [defect, browser-testing]
---

# Forking from a parent whose turn is streaming loses follow mode on the fork, because the follow armed on the parent is released by the parent's own turn ending and then moved onto the fork

Found 2026-09-30 by the implementer of OW-koledi, reproduced with a throwaway fake-controller run in `src/client/App.test.ts` that was reverted: forked from a streaming parent whose turn then ends mid-fork, the fork's turn did not scroll (`scrollTop` read 0 where 400 was expected), while the same run from an idle parent passed.

This is OW-koledi's defect in the follow state rather than the badge.
OW-koledi (commit subject "client: arm a fork's badge on the fork when its attach replies, never on the parent (OW-koledi)") moved the badge off the parent: `forkAndSubmit` in `src/client/controller.ts` now takes an `onAttached(handle)` callback fired when the fork's attach replies, before `api.prompt`, and `send()` in `src/client/App.svelte` arms the badge's `watchSubmit` there on the fork's handle.
Follow was left as it was: `send()` still calls `armFollow` on the parent's key, which sets `pendingFollow` keyed by the parent's handle, and only when `forkAndSubmit` resolves does `rekeySession(armedKey, landed.handle)` move `pendingFollow` onto the fork.
Meanwhile the effect that consumes `pendingFollow` (the block reading "const pendingFrom = pendingFollow.get(key);" in `App.svelte`) sees the parent streaming and then not, and releases the follow against the parent's turn, so `rekeySession` later moves released state onto the fork.

Load-bearing: the follow, like the badge, belongs to the fork from the moment its handle is known, and the parent's turn ending during the fork (Pi's abort in `forkAndSubmit`; a Codex or Claude Code turn finishing on its own) must neither consume it nor strand it.
The likely direction is the same `onAttached` callback, arming follow on the fork's handle with the fork index `send()` already passes to `armFollow`, but that is the executor's to confirm; OW-hezidi and OW-suhoto are the closed cards whose Pi-shaped fork tests ("a Pi-shaped fork ends on the fork's own handle with the follow and scroll maps moved onto it (OW-hezidi)") pin what the move must keep.
Follow mode's scrolling is layout jsdom cannot see in full, so per `AGENTS.md`, "Commands", run `bun run test:browser` by hand before committing if `App.svelte`'s follow-mode scrolling changes.

Done when a test in `src/client/App.test.ts`, red first, drives the real controller (`createController`, as OW-koledi's "badges the fork's turn and not the streaming %s parent's that ends mid-fork" does) through a fork from a streaming parent whose turn ends mid-fork, then streams the fork's turn, and asserts the transcript follows it; `bun run test:browser` and `bun run check` pass.
