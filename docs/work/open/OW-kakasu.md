---
labels: [defect, emacs]
---

# agentpane-mode's turn-done watch is one cons shared by every prompt that joins it, so after a merge one prompt's refused or handled answer drops the watch another prompt joined

Filed 2026-10-15 from the adversarial read of OW-kejire (commit "emacs: a handled prompt's answer drops its turn watch from the request's reply, whatever became of the buffer (OW-kejire)"); confirmed by running a probe ERT test, on the handled and the refused answer both.

The turn-done watch in `emacs/agentpane.el` is one cons per session handle in the global `agentpane--turn-watches`.
`agentpane--watch-submit` arms it and returns the cons, or returns nil when a watch already stands on the handle and the prompt joins it; `agentpane--watch-abandon` drops a returned cons by identity.
That identity rule is the guard: "drop only what this prompt armed" (the `agentpane--watch-submit` docblock, paragraph beginning "A prompt refused mid-turn (D16) leaves the running turn's watch standing by identity").
It cannot tell a watch nobody else joined from one another prompt now depends on, because nothing records the joins.

The case it misses needs a merge, since `agentpane--sending` is buffer-local and otherwise admits one prompt in flight per session:

1. The holder buffer sends `/mcp` (or any prompt the server will refuse) and arms watch W on handle "h1", `sent`.
2. A previewing buffer attaches to the same session and the merge (`agentpane--absorb`) kills the holder; the prompt is still out.
3. The survivor sends a real prompt; its own `agentpane--sending` is nil, so it goes out, and `agentpane--watch-submit` joins W and returns nil.
4. The holder's prompt answers `(:disposition "handled")`, whose REPLIED in `agentpane--send-prompt` abandons W since OW-kejire, or is refused, whose UNSENT abandons W since OW-dunahe.
5. The survivor's own turn streams and ends while no window shows it, and the indicator is not raised for a turn this Emacs asked for.

The refused variant fails on main before OW-kejire too; the handled variant passed there only because the killed holder's reply callback never ran, so OW-kejire's case 1 fix regressed it, knowingly, in the direction the repo prefers (a missed indicator, never a false one).
The browser cannot reach this: `view.sending` in `src/client/App.svelte` admits one submit in flight per tab and a tab has no merge, which is why OW-zikiga's join-and-report in `armBadge` is sound there.
The reader's probe, to adapt as the red test: drive `agentpane-test--merging` through the real `agentpane--request` over a stub `jsonrpc-async-request`, as `agentpane-test-turn-done-abandoned-by-a-handled-answer-after-a-merge` in `emacs/agentpane-test.el` does, but have the previewing buffer `agentpane-send` a prompt instead of only attaching, then answer the holder's prompt and the survivor's, stream, and assert the indicator.

The fix changes the watch's owner, not the abandon site: the watch records which prompts claim it, `agentpane--watch-submit` returns a claim whether it armed or joined, and an abandon removes that claim, dropping the watch only when no claim remains.
That covers the refused and the handled answers through one mechanism, and the "by identity" reasoning in the `agentpane--watch-submit`, `agentpane--watch-abandon` and `agentpane--send-prompt` docblocks is restated for claims.
Keep what OW-kejire and OW-zikiga decided: an abandon drops a watch whose last claim it held whether `sent` or `streamed`, and an indicator already raised stays.

## Done when

ERT tests in `emacs/agentpane-test.el`, each red first, have the survivor of a merge send a prompt that joins the dead holder's watch, then answer the holder's prompt handled in one and refused in the other, and assert the survivor's turn ending unseen raises the indicator.
The existing watch tests, among them `agentpane-test-turn-done-kept-armed-by-a-prompt-refused-mid-turn`, `agentpane-test-turn-done-abandoned-by-a-refusal-after-a-merge` and the three tagged OW-kejire, still pass.
`agentpane--watch-abandon` no longer drops a watch by the identity of a cons that other prompts share; the identity rule is gone, not joined by a second check.
The suite passes under `emacs --batch -L emacs -l ert -l agentpane -l emacs/agentpane-test.el -f ert-run-tests-batch-and-exit`, which `bun run check` does not run.
