---
labels: [defect, emacs]
---

# A buffer told its handle is gone, whose ref a rename it never heard and then a close left naming nothing, cannot come back: its attach by the old ref answers 404 for a Pi virtual session

Left open by OW-yibijo on 2026-09-25, and recorded as open in `docs/DESIGN.md` D21, the paragraph containing "Still open is a buffer whose ref no longer reaches its session", and in the D24 sentence ending "and a prompt that races a close (D21)".
It is what remains of OW-nibihi, which OW-yibijo made moot: the buffer no longer counts itself attached over a frozen transcript, but it has no way back.

## The sequence

While the Emacs helper's stream is down, or with it up, another client prompts a Pi `virtual` session for the first time, which renames it onto its real id (D9), and then closes it; later someone attaches the real id.
The buffer holds the `virtual` ref.
The helper's listing lacks the buffer's handle, so the buffer gets `session/detached` (`dropDead` in `src/emacs/helper.ts`), and sets `agentpane--dropped` in `emacs/agentpane.el`, so its `g` attaches instead of previewing.
That attach names the `virtual` ref, which no container carries once the renamed one is gone: `SessionManager.attach` in `src/server/http/session-manager.ts` misses in `#names`, and `#start` falls to `#index.get`, which knows no `virtual` id, so the route answers 404.
`agentpane--dropped` stays set across a failed attach by design (its docstring), so every `g` retries the same 404.

A Claude Code session renamed by an `init` naming another `session_id` (`ClaudeAdapter.ref`'s docblock in `src/server/adapters/claude/`) may fall the same way but differently: if the CLI leaves the old id's store file behind, the attach succeeds and resumes the pre-rename conversation beside the live renamed one, and the buffer silently takes it.
That was reasoned by OW-yibijo's adversarial reader and never measured; measure it (per `AGENTS.md`, "Evidence", naming the `claude` version, with `--model haiku`) before designing for it, and record the result in `docs/MANUAL_TESTING.md`.

## What to decide

Whether the buffer can learn the name its session went to, and from where, given that no rename tracker is wanted (D24), or whether it should simply stop retrying and read as a preview of whatever its ref still names.
The browser may have the same gap for a view holding the old ref; check it, and per `AGENTS.md`, "Both clients", land any user-facing change in both clients or file each client's card.

## Done when

A test in `src/emacs/helper.test.ts` or `emacs/agentpane-test.el`, red first, drives rename, close, re-attach by the new id, and the buffer's `g`, and asserts the chosen outcome; and D21's "Still open" sentence says what is still open, if anything.
