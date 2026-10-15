---
labels: [question]
closed: done
---

# Should agentpane show what a Pi extension command says through notify, now that a handled prompt's only output is that notify and the reducer drops it

Filed 2026-10-14 from OW-kokotu's live run on the home server, `pi 1.2.0`; see `docs/MANUAL_TESTING.md`, "A second Pi prompt sent before the first's `agent_start` is refused, and an extension command's is answered with nothing (OW-kokotu)", subsection "A prompt an extension command handles".

Each of the three extension commands on the home server answered its prompt `handled` after one `extension_ui_request` with method `notify`, and that was the command's whole output: `/mcp` said `No MCP servers configured. Add them to <state dir>/mcp.json or .pi/mcp.json.`, `/llama` said `/llama is available in interactive mode`, `/refs` said `No @references found in AGENTS.md files`.
`reducePiNotification` in `src/server/adapters/pi/reducer.ts` drops every fire-and-forget `extension_ui_request` (its `extension_ui_request` case: "presentation hints with no reply and no home in the frozen `ServerEvent` union"), so none of that text reaches either client.
That decision predates handled prompts, when a `notify` was decoration on a running turn; for a handled prompt it is the answer.
That comment also predates OW-tujiya: `ServerEvent` in `src/shared/protocol.ts` has since gained a per-session `notice` arm carrying an `AgentNotice`, which the Codex adapter feeds through the optional `onNotice` in `src/server/adapters/types.ts`, the session manager holds for every snapshot (accumulating, never dismissed, an identical one not repeated, OW-piloni), and both clients already draw — the browser's `.notices` list in `App.svelte`, Emacs's `session/notice` node in `emacs/agentpane.el`; the Pi adapter implements no `onNotice`.
OW-yosuzo is the closed card that settled how dialogs are refused and kept `notify` uncancelled, and is the prior art to read.

The decision: whether a handled prompt's `notify` text is shown, and if so whether that is all `notify`s or only those that arrive with a handled prompt, given that OW-dulipe already puts the handled outcome on both wires.
Whatever is decided, both clients follow it (AGENTS.md "Both clients").

Done when the decision is recorded in `docs/DESIGN.md`, either as an amendment to D11 (the decision that keeps `ServerEvent` frozen) or as a new one, and, if it is to show the text, the cards that carry it are filed: a wire card and two client cards blocked by it where the text needs a carrier the wire lacks, or one server card alone where the existing `notice` arm carries it to both clients.

## Close note

Decided by the owner on 2026-10-14: every Pi `notify` reaches both clients on the per-session `notice` arm (`kind` "notify"); `setStatus`, `setWidget`, `setTitle` and `set_editor_text` stay dropped. Recorded in `docs/DESIGN.md` D11, the paragraph "Pi's `notify` is a notice."

The premise that `ServerEvent` had no home for it was stale: OW-tujiya added the per-session `notice` arm on 2026-09-24, which both clients already draw, while the reducer's drop dates to 2026-08-11. Showing only the notifies that arrive with a handled prompt was weighed and rejected, because it would add client work coupled to OW-dulipe's handled outcome and would still drop the notify an extension sends at `session_start` (`auto-read-agents-refs.ts` on the home server sends one, read at source). Keeping the drop was rejected because a handled prompt's notify is the command's whole output (`pi 1.2.0`, OW-kokotu).

Since the wire already exists, it takes one server card rather than a wire card and two client cards: OW-fusoba, which also covers multi-line messages being drawn as lines in both clients and the four docblocks that claim only Codex produces notices. An adversarial reader checked the decision and the card against the code; its five findings were folded into both before commit.
