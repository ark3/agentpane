---
labels: [change, emacs-native]
closed: done
---

# A folded tool call in agentpane-mode takes a wrapped header plus a meta line; it should take one screen line carrying its message's meta, with agent-shell's look borrowed for the rest

Owner, 2026-09-23, on the work laptop against Claude Code: outside reading view, tool calls and thinking look much nicer in the web UI than in Emacs, but Emacs could look better still without the web UI's box model, and "agent-shell has a great renderer".
The pain point the owner named is height: each folded tool call takes several lines, because the name plus one-line summary already wraps, and the meta line follows it.

## The one-line rule

This is the load-bearing part, agreed with the owner on 2026-09-23.
When an assistant node's last part is a `tool` part, its meta goes on that tool's folded header line instead of a line of its own, and each folded tool header takes exactly one screen line.
The summary is what gives way: it is cut short with `…` to leave room for the name, the state marker and, on the last tool, the meta; unfolding shows the whole summary with `args`, `result` and any diff, as today.
A node that ends in text keeps its meta on its own line below the text, as the browser does.

An assistant node is one model step, not one tool call: the Claude store's entries are merged by API `message.id` (`src/server/adapters/claude/reducer.ts`, "merge by that id"), so a step with parallel calls is one node with several `tool` parts and one meta, and so is a Codex or Pi turn with several calls.
The owner's screenshot of such a step in the browser: two `Bash` cards, then one row reading `2026-09-21 16:42:16  claude-opus-5  49K tok`.
In Emacs that step should draw roughly as

    Bash rg -n "def delete_target|def remove_t…
    Bash rg -n "track_quality|swt_track_qua… · 2026-09-21 16:42:16 · claude-opus-5 · 49K tok

The meta's content is not this card's: OW-janimi reshapes its fields and OW-fokisa adds the timestamp, so draw whatever `agentpane--insert-meta` produces by then, factored so the header can carry it, rather than today's fields.
The meta keeps its warning face on an aborted or errored step; a long `errorMessage` would not fit, so where the meta carries one it may keep its own line, the implementer's first cut to state in the close note.

What fitting means is a first cut too, stated in the close note.
The buffer's `default` is remapped to `variable-pitch` (`agentpane-prose`), so a character count is not a width; `string-pixel-width` against `window-body-width` in pixels is the likely measure.
The width is the window's at draw time, and a buffer can be shown in several windows or resized; whether the headers are redrawn on a width change (`window-size-change-functions`) or simply fit the width they were drawn at is the implementer's call.
Thinking's header already shows only the first line of the thinking and may wrap the same way; fitting it to one line likewise is in scope.
OW-fokisa left one fact for this card to draw: a `tool` part's `timestamp`, the result's time, carried since then and drawn nowhere; the browser shows it in the tool card's body, and where it goes here is the implementer's call within the one-line rule.

## Where things stand

D22 in `docs/DESIGN.md` and OW-vibipo's "Rendering verdict, 2026-09-22" settled the prose, drawn through `shr`; what the owner disliked in `agent-shell` was its prose rendering, and neither record judged its tool calls.
OW-dekate's rounds judged the prose and left the tool and thinking drawing at its first round, which OW-wavone's "Drawing" list carried over: `agentpane--insert-tool` draws the tool name, its `summary` and a state marker on one fold line, with `args`, `result` and diff lines behind it (`agentpane--tool-body`, `agentpane--diff-text`), and `agentpane--insert-thinking` draws `thinking: ` plus the first line in italics, the rest folded; both in `emacs/agentpane.el`, both built on `agentpane--insert-fold`.
`agentpane--pp-node` calls `agentpane--insert-meta` after the parts, which is where the one-line rule changes the order.
The data is the `tool` and `thinking` parts in the "Parts" list of `src/emacs/protocol.ts`; a new look may want a field the node does not carry, and adding one goes through `src/emacs/nodes.ts` and the contract with a test there.

## The reference for the rest

`agent-shell` 7377ba8 (2026-09-11) is installed under the home server's `~/.emacs.d/straight/repos/agent-shell/`, the version OW-vibipo read, and the owner's work laptop Emacs has it too.
Its tool-call and thinking fragments are drawn in `agent-shell-ui.el` and driven from the `tool_call` and `tool_call_update` handling in `agent-shell.el`, with faces in `agent-shell-faces.el` and `agent-shell-styles.el`.
Read it for what makes it look good -- header layout, status glyphs, how the body is framed and indented, how a diff and a long result are shown, how thinking is set apart -- and borrow the look, not the code or its fragment model, within the one-line rule above.

## How it closes

The one-line rule closes on tests; the rest of the look is a first cut borrowed from `agent-shell` and drawn against stored sessions with parallel tool calls, Edit diffs, shell commands and thinking.
Amended 2026-09-23 under the rule in `AGENTS.md`, "Cards": the card closes once that is shown to work, and the owner's rounds on the look are later cards, not this one's close.

New `ert` tests in `emacs/agentpane-test.el`, run as that file's Commentary says, each red before the change:
- a node with two tool parts and meta draws the meta's model on the second tool's header line and on no line of its own, and the first tool's header carries no meta;
- a tool whose summary is far wider than the window draws a header that is one line, ending its summary in `…`, and unfolding it shows the whole summary;
- a node ending in text still draws its meta on its own line after the text.
The rest of that file stays green, fold toggling, diff faces and a signature-only thinking part drawing nothing among it, with any test the change breaks updated rather than deleted and the pass count in `emacs/agentpane.el`'s Commentary updated.
Done when those pass and the first cut of the look is landed, with what it borrowed from `agent-shell` and the first cuts named above in this card's close note.

## Close note

Landed as 397d667 on main; `emacs/agentpane.el` and `emacs/agentpane-test.el` only.
The one-line rule: a step whose last drawn part is a tool call puts its meta on that header (` · <time> · <model> · <tokens>`), and each tool and thinking header is fitted to one screen line by `agentpane--fit-header`, the summary cut with `…`; unfolding a cut tool shows the whole summary at the head of its body.
"Last drawn" skips empty text, signature-only thinking and what reading view elides, so with reading on the meta goes on its own line after the surviving text.
`agentpane--insert-meta` was split into `agentpane--meta-text`, `agentpane--insert-meta` and `agentpane--meta-tail`, keeping OW-fokisa's `showsMeta` rule and OW-janimi's fields.
First cuts: the measure is `string-pixel-width` under the buffer's face remapping against the narrowest window showing the buffer, less one character; a width change redraws every node after 0.2s idle (`agentpane--refit-on-resize` on buffer-local `window-size-change-functions`); a meta carrying `errorMessage` keeps its own line, as does one that will not fit beside a lone `…`; the tool's result time is the last line of its folded body, where the browser's card draws it.
Borrowed from `agent-shell` 7377ba8: a status mark before the name (`✓` in a new `agentpane-tool-ok` face, `✗`, `◔` running), the name in `font-lock-doc-markup-face`, `+N −M` in the diff faces, a two-space display-only body indent with blank lines between sections, and `✶ Thinking` as the thinking label.
Declined: its fold triangles, its boxed file label on diffs, and its blank line after a body, which made shr drop the paragraph break before following text.
The invisibility ellipsis after a folded header is gone.
Verified: the card's three tests, a reading-view test and a refit-at-new-width test, each shown red; three existing tests updated for the new header text; ert 65 of 65, byte-compile clean.
Drawn in batch from stored Claude and Codex sessions: a two-call step now reads `▸ ✓ Bash card workflow; echo… · 2026-09-23 12:04:52 · claude-opus-5-5 · 30K tok` where it took three lines.
Noted, not filed: at 80 columns a Claude meta takes about 45 characters of the header, and fitting tripled a 49-node batch draw from 21ms to 63ms; both are for the owner's rounds on the look.
The owner's verdict on the look was dropped as a close condition on 2026-09-23 under the rule in `AGENTS.md`, "Cards".
