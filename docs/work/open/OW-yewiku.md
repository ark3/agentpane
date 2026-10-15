---
labels: [defect]
---

# A Pi prompt steered into a run and not yet delivered when the user stops the run goes somewhere the user did not aim it

Filed 2026-10-15 from OW-wibude's adversarial read, which read it at Pi's installed source; nothing here has been run.
It predates OW-wibude: every prompt steered mid-turn under D16 in `docs/DESIGN.md` ("A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects") could meet it, and OW-wibude added only the prompts sent before a run's `agent_start`, which used to get a 500 instead.
OW-pefawi is the Codex counterpart, closed; nothing recorded the Pi side.

## What the source says, on `pi 1.2.0`

Pi's package on the home server is under `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`.
- A `prompt` carrying `streamingBehavior: "steer"` while Pi is busy goes into the steering queue (`AgentSession.prompt` in `dist/core/agent-session.js`, the `if (this.isStreaming)` branch) and is answered `{"disposition": "queued"}`; agentpane's route then answers 202.
- `AgentSession.abort` sets `_agentRunAbortRequested` and calls `agent.abort()`, and neither clears the steering queue; only `clearQueue()` does.
  `_startRun`'s loop `while (!this._agentRunAbortRequested)` and `_handlePostAgentRun` both skip their `hasQueuedMessages()` checks on abort, so the reader inferred the message stays queued and is injected into the next prompt's run at the loop's initial steering poll (`pi-agent-core`'s `dist/agent-loop.js`).
- Pi's own `docs/rpc-commands.md`, section "clear_queue", says the opposite of stranding: "`abort` continues queued messages when they remain in the session", and tells a client implementing Esc to "send `clear_queue` before `abort`, then restore the returned text in the client editor".
  Pi's interactive mode does that.
- `PiAdapter.abort` in `src/server/adapters/pi/process.ts` sends `abort` alone, and `PiAdapter.compact` sends `compact`, which in Pi calls `abort()` first.
- `reducePiNotification` in `src/server/adapters/pi/reducer.ts` drops `queue_update` (the `default:` arm's comment), so neither client learns the message was queued or that it is still there.

So after Stop, a steered prompt that had not yet been delivered either runs on its own after the stop (Pi's docs) or turns up inside whatever the user sends next (the reader's reading of the code).
The user, who saw a 202 and pressed Stop, expected neither.

## Done when

- `docs/MANUAL_TESTING.md` records a live run on the home server, naming the `pi --version` and whether Pi ran against its own `~/.pi/agent` or a throwaway `PI_CODING_AGENT_DIR`, of a prompt steered into a running turn and then aborted before Pi delivered it, showing where that prompt's text went: run after the abort, kept for the next prompt, or dropped.
  `resources/probes/agentpane_pi_steer_probe.py` and `resources/probes/agentpane_pi_prompt_window_probe.py` already tap Pi's stdout and stdin through a `pi` shim and read `queue_update`; extend one of them, or add a cell, rather than starting fresh.
  Note that a steer is delivered after the current tool batch, so holding it undelivered needs a turn that is still running tools or still streaming its first reply when the abort goes out.
- Whatever the run shows, the decision about what agentpane's Stop does with a queued prompt is recorded in D16 in `docs/DESIGN.md`, and the change follows it.
  If the decision is Pi's own Esc behaviour (`clear_queue` before `abort`, text handed back to the composer), that is a user-facing capability: per AGENTS.md, "Both clients", the wire card carries it onto the HTTP API and `src/emacs/protocol.ts`, with a browser card and an `emacs` card blocked by it.
- Any code change closes on a test in `src/server/adapters/pi/process.test.ts`, shown red first, asserting the commands `abort()` (and `compact()`, if the decision covers it) writes to Pi.

## Decided 2026-10-15 by the owner

Stop does what Pi's own interactive mode does with Esc: agentpane sends `clear_queue` before `abort`, and the text of every steered prompt Pi had not yet delivered goes back to the composer of the client that pressed Stop.
Nothing the user typed is lost, and nothing runs after Stop.
The live run is still made, because D16 records what Pi does without the change, with its version, and the wire card needs to know what `clear_queue` returns on `pi 1.2.0`.

So this card closes when: the run is recorded; the decision is in D16 in `docs/DESIGN.md`, beside the run's finding; and the three cards that carry it are filed, rather than built here.
The wire card changes `PiAdapter.abort` in `src/server/adapters/pi/process.ts` to send `clear_queue` first, with the `process.test.ts` test the last bullet above asks for, and carries the returned text onto the HTTP API and the Emacs helper's JSON-RPC in `src/emacs/protocol.ts`; whether `compact()`, which Pi begins with an abort, does the same is that card's to settle.
A browser card and an `emacs` card, each blocked by the wire card, put the text back in that client's composer.
The adapter change and the wire land together in the wire card, so no build ever clears the queue without handing the text back.
