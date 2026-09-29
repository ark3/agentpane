---
labels: [defect]
closed: done
---

# A Claude Code control_request the adapter did not send is dropped silently, so one that arrives stalls the turn with no error line

Found 2026-09-29 while executing OW-letevu, which made D2a final: agentpane never holds an agent request, and the Codex and Pi adapters refuse one at arrival and name it in a session error.
The Claude Code adapter has no such path, and D2a's "Claude Code has no refusal, and needs none" bullet in `docs/DESIGN.md` records why none was built.

## The gap

`ClaudeAdapter.handleLine` in `src/server/adapters/claude/adapter.ts` handles `control_response` itself and passes every other event to `ClaudeReducer.handle` (`src/server/adapters/claude/reducer.ts`), whose `default:` arm returns `[]` with the comment "control_request/control_response are the adapter's business".
So a CLI-initiated `control_request` reaches nothing: no reply is written, no session error is posted, and the CLI waits on its answer while the turn sits.

The one kind known to exist, `can_use_tool`, cannot arrive under agentpane's spawn, because it is sent only under the undocumented `--permission-prompt-tool stdio`, which the adapter does not pass; the adapter's module docblock says so in its bullet beginning "No agent request is refused here".
That is exactly the shape `docs/DESIGN.md` D18 names in its third group, "Facts that license code that does not exist": a run showed an input cannot arrive, so nothing handles it, and if a Claude Code release starts sending a `control_request` of any subtype under agentpane's flags, "there is no test to go red and no log line".
D18's defence for that group is a runtime assertion that makes the impossible input loud where it arrives, which Codex has had since OW-nujawi and Pi since OW-yosuzo.

## What done looks like

A `control_request` from the CLI, of any subtype, produces a session error naming its subtype, in the tick it arrives.
A test in `src/server/adapters/claude/adapter.test.ts` feeds one through the adapter's fake child and asserts that error, and is seen red first by removing the new arm.
The request shape to feed is the `can_use_tool` line in `resources/fixtures/claude/permission-request.jsonl` (`claude 2.1.238`), which is the only CLI-initiated `control_request` captured.

Whether the adapter also answers it on the wire is part of the card, and the evidence decides it: that fixture captured only an allow, so a deny or error `control_response` shape is unmeasured, and a reply sent in a guessed shape could be worse than none.
Either measure a shape live on the home server under `claude --model haiku`, recording it in `docs/MANUAL_TESTING.md` with the CLI version, or post the error without a reply and say so in the adapter's module docblock and D2a's Claude Code bullet.
Whichever way it goes, update D2a's Claude Code bullet in `docs/DESIGN.md` so it no longer says a `can_use_tool` "would stall the turn" silently.

## Close note

Landed on main in 79e3616 (docs) and 2444728 (server).

Evidence: measured live on the home server on 2026-09-29 (`claude 2.1.283`, explicit `--model haiku`, spawned directly with `--permission-prompt-tool stdio` and not through sbox, because sbox's bypassPermissions would suppress the ask).
Both reply shapes answering a `can_use_tool` were accepted: the generic error `control_response` (`subtype: "error"`) and a success carrying `behavior: "deny"`.
Each reached the model as an `is_error` tool result, and the turn went on to `result` with the Edit listed in `permission_denials`.
The deny reads cleaner, because the error form gets a "Tool permission request failed: Error:" prefix.
Recorded in `docs/MANUAL_TESTING.md` under the OW-kihubu section.
No other CLI-initiated subtype could be provoked, so the error reply was measured on `can_use_tool` only.

Built: `ClaudeAdapter.handleLine` now routes `control_request` to `refuseControlRequest` in `src/server/adapters/claude/adapter.ts`.
A `can_use_tool` gets the deny and the error "claude sent a request agentpane cannot answer (can_use_tool); agentpane declined it".
Any other subtype gets the error reply and "claude sent an unsupported request (SUBTYPE); agentpane declined it".
The wording mirrors Codex's.
D2a's Claude Code bullet, its headline and error-line count, D18's third group, and the adapter's module docblock are updated, and the "would stall the turn" claim is gone from src/ and docs/DESIGN.md.

Verified: two tests in `src/server/adapters/claude/adapter.test.ts` (the fixture's `can_use_tool`, and an `elicitation` subtype).
The dispatching session saw both go red with the arm removed and green with it restored, and `bun run check` passed on the implementer's branch, whose tree is identical to what landed.
