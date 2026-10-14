---
labels: [defect]
blocked-by: [OW-meriva]
---

# A Pi role:system message is dropped from the stored preview, and wherever it reaches a client it renders as a raw JSON dump of the system prompt

Filed 2026-10-14 from a reading of Pi's changelog and the home server's own Pi session files, and confirmed in use: the owner reported the same day seeing the JSON dump below regularly in both the browser and agentpane-mode, running the latest `pi`, `1.2.0` that day.

Pi writes mid-conversation messages with `role: "system"` when its system prompt or tool set changes, so instruction and tool updates survive resume and branch navigation.
Pi's changelog puts their introduction at `0.86.0` ("transcript-backed mid-conversation system prompt and tool changes"), and at `0.99.2` an `mcp_servers` section changing is appended to the conversation too, so they become more frequent with MCP in use.
On 2026-10-14 all four Pi session files under the home server's `~/.pi/agent/sessions` written since 2026-10-03 held one, a `type: "message"` entry whose message has the keys `content`, `role`, `sections`, `timestamp` and `toolsAdded`; the nine written 2026-09-14 to 2026-09-16 held none.

Amended 2026-10-14 at execution, after re-reading those four files: in every one the system message is the *leading* message entry, index 0, not a mid-conversation change.
Each has an empty `content`, five `sections` (`preamble`, `tools`, `rules`, `docs`, `cwd`, about 2.7k characters together) and ten tool definitions in `toolsAdded` (`read`, `bash`, `edit`, `write`, `spawn_shell`, `wait`, `jobs`, `spawn_agent`, `resume_agent`, `kill`), and none holds a later one.
The pinned `@earendil-works/pi-ai` 1.2.0 types say why: its `SystemMessage` docblock reads "The leading system message is the system prompt. Later system messages change it", and `Message` is now `SystemMessage | UserMessage | AssistantMessage | ToolResultMessage`.
So the case observed in use is Pi's whole system prompt opening every session from `1.2.0` on, and a mid-conversation update is the rarer case; the decision below covers both.

What agentpane does with one, read from the code:

- The stored preview drops it: `storedAgentMessage` in `src/server/sessions/preview-message.ts` has no `system` arm and returns `null`.
- If it arrives live, through `message_start`/`message_end` in `reducePiNotification` (`src/server/adapters/pi/reducer.ts`), or on a load through `get_messages`, it reaches the clients as a message of an unknown role.
  The browser's `Message.svelte` then takes its final `{:else}`, the `msg unknown` article, and prints the whole message as JSON; `nodeFor` in `src/emacs/nodes.ts` does the same in its `default` arm.
  That JSON is the system prompt, so the reader gets a wall of it in the middle of the transcript.
- So the live view and the preview of the same session disagree, and each is wrong in its own way.

So they do reach the clients on `pi 1.2.0`; which path carries them — the live `message_start`/`message_end`, a load's `get_messages`, or both — is not yet measured, and the fix must cover whichever do.

In service of a reader seeing the same transcript live and in the preview, and of a system prompt change being legible, or deliberately invisible, rather than a JSON dump.
Both clients land whatever is decided (AGENTS.md, "Both clients").

## The decision this needs

How a system-role message should appear is the owner's call, and this card runs with the owner in the session, not through `card run`.
The candidates run from not showing it at all, through a one-line marker naming what changed (`toolsAdded`, `toolsRemoved`, which `sections` changed), to the marker with the text behind a disclosure.
A first cut the owner then judges in use is the expected way to make it, marked as a first cut where it is recorded.

## Done when

A live run on the installed `pi`, with the pinned `--model openrouter/deepseek/deepseek-v4.1-flash:high`, records in `docs/MANUAL_TESTING.md` whether a system-role message arrives live on the RPC wire and whether `get_messages` returns it, with the version.
The decision is recorded where a reader of the rendering code meets it, the docblock of whatever renders the role.
A test feeds a system-role message through the preview path and asserts it yields what was decided, red before the change, and one feeds it through the live reducer and asserts the same projection; the browser and `src/emacs/nodes.ts` each have a test that it no longer renders as an unknown role.
If OW-piyulu has closed, its Pi conformance test's known-differences table loses any entry this card owned.

## Decided

The owner chose on 2026-10-14, after the live run recorded in `docs/MANUAL_TESTING.md` ("Pi's system-role messages arrive live and from `get_messages` (OW-wavini)"): every system message, the leading one included, renders as a one-line marker naming what it carries, with its text behind a disclosure, in both clients.
It is a first cut, to be judged in use.
