---
labels: [question]
---

# Should agentpane show what a Pi extension command says through notify, now that a handled prompt's only output is that notify and the reducer drops it

Filed 2026-10-14 from OW-kokotu's live run on the home server, `pi 1.2.0`; see `docs/MANUAL_TESTING.md`, "A second Pi prompt sent before the first's `agent_start` is refused, and an extension command's is answered with nothing (OW-kokotu)", subsection "A prompt an extension command handles".

Each of the three extension commands on the home server answered its prompt `handled` after one `extension_ui_request` with method `notify`, and that was the command's whole output: `/mcp` said `No MCP servers configured. Add them to <state dir>/mcp.json or .pi/mcp.json.`, `/llama` said `/llama is available in interactive mode`, `/refs` said `No @references found in AGENTS.md files`.
`reducePiNotification` in `src/server/adapters/pi/reducer.ts` drops every fire-and-forget `extension_ui_request` (its `extension_ui_request` case: "presentation hints with no reply and no home in the frozen `ServerEvent` union"), so none of that text reaches either client.
That decision predates handled prompts, when a `notify` was decoration on a running turn; for a handled prompt it is the answer.
OW-yosuzo is the closed card that settled how dialogs are refused and kept `notify` uncancelled, and is the prior art to read.

The decision: whether a handled prompt's `notify` text is shown, and if so whether that is all `notify`s or only those that arrive with a handled prompt, given that OW-dulipe already puts the handled outcome on both wires.
Whatever is decided, both clients follow it (AGENTS.md "Both clients").

Done when the decision is recorded in `docs/DESIGN.md`, either as an amendment to the decision that keeps `ServerEvent` frozen or as a new one, and, if it is to show the text, a wire card and two client cards blocked by it are filed.
