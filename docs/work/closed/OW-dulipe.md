---
labels: [defect]
closed: done
---

# A Pi prompt an extension command consumes is answered 202 like a started turn, and neither wire lets a client tell that no turn is coming

Filed 2026-10-14 from OW-kokotu's live run on the home server, `pi 1.2.0`, pinned `openrouter/deepseek/deepseek-v4.1-flash:high`; see `docs/MANUAL_TESTING.md`, "A second Pi prompt sent before the first's `agent_start` is refused, and an extension command's is answered with nothing (OW-kokotu)", subsection "A prompt an extension command handles".

In service of a prompt the user sends either running or being refused visibly, never sitting accepted with nothing happening.

## What happens

On the home server's stock configuration `get_commands` lists three extension commands: `/refs` (the user extension `auto-read-agents-refs.ts`) and `/llama` and `/mcp`, built in and loaded unless `--no-extensions`.
agentpane passes a leading `/` to Pi as text (OW-73), and Pi hands it to `_tryExecuteExtensionCommand` first; each of the three was answered `{"disposition": "handled"}` and no run started — per Pi's `docs/rpc.md`, "If it is `"handled"`, no run started for this prompt, so don't wait for `agent_settled`."
Through agentpane the prompt route answered 202, and for five seconds after it the SSE stream carried no event at all under the session's handle; the next ordinary prompt ran normally.
Read at Pi's source, prompt templates and `/skill:` forms expand and answer `started`; only an extension command or an `input` handler that consumes the text answers `handled`.

The `prompt` arm of `PiResponse` in `src/server/adapters/pi/protocol.ts` has no `data`, `PiAdapter.submit` in `src/server/adapters/pi/process.ts` ignores the response body, and `BackendAdapter.submit` resolves `void`, so nothing above the adapter can learn the disposition.

## The change

Carry "admitted, and no turn will follow" from `PiAdapter.submit` up through `SessionManager.submit` to both wires: the HTTP prompt route (`src/server/http/app.ts`, its types in `src/shared/protocol.ts`) and the Emacs helper's `sessions/prompt` in `src/emacs/protocol.ts`, whose result is `null` today.
The shape is the executor's; load-bearing is only that the client which sent the prompt can tell, from the answer to that prompt, a handled one from a started one.
Codex and Claude Code have no such outcome, and their adapters keep answering as a started turn.
The two client halves are their own cards, blocked by this one, per AGENTS.md "Both clients"; what Pi's `notify` for the command said is a separate question card.

## Done when

- A test in `src/server/adapters/pi/process.test.ts`, red first, has a faked `prompt` response carrying `data.disposition: "handled"` and asserts `submit()` reports it.
- A test at the HTTP route and one at the helper's `sessions/prompt` assert the handled outcome reaches each wire, and a started one still reads as today.
- `bun run check` passes.

## Close note

Built 2026-10-14 (commit "a Pi prompt an extension command handles answers 200 with its disposition on both wires").
`BackendAdapter.submit` and `SessionManager.submit` resolve a `PromptDisposition` (`"started" | "handled"`, `src/shared/protocol.ts`); `PiAdapter.submit` reads Pi's `data.disposition`, mapping `queued` and an absent `data` to started; Codex and Claude Code always answer started.
The HTTP prompt route answers a handled prompt 200 with `PromptResponse` `{ "disposition": "handled" }` and keeps the bodiless 202 for a started one; `api.prompt` resolves the body or nothing; the Emacs helper's `sessions/prompt` answers the body or `null`.
Verified: the adapter test in `src/server/adapters/pi/process.test.ts` went red first (`expected undefined to be 'handled'`); the route test in `src/server/http/app.test.ts` and the helper test in `src/emacs/helper.test.ts` were each shown red by disabling the handled branch; `bun run check` passed, 1661 tests.
Adversarial review found that `handled` does not mean nothing follows: `pi 1.2.0`'s `docs/rpc-commands.md` "prompt" says it "describes the submitted prompt, not independent work started by an extension", and Pi's `/ask` example streams a turn after it (read at source, not run).
The docs say "no turn started for this prompt" accordingly, and a guard the implementer added to keep the held error on a handled prompt was removed, since that case defeats it; the question went to OW-webiwu.
OW-yobayi and OW-taviju were amended with the wire shape and this caveat.
