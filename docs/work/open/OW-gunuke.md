---
labels: [change, emacs, emacs-native]
blocked-by: [OW-wavone]
---

# agentpane-mode attaches a session, streams the tail into the transcript buffer, and prompts, aborts and compacts from a composer buffer, with the model chosen before the first prompt

Filed 2026-09-15, the native-mode stream (OW-mutufa, OW-refibu, OW-wavone).
The live slice: what turns the read-only transcript buffer of OW-wavone into a client.

## Attach and stream

Opening a session for use, or the first prompt on a previewed one, sends `sessions/attach`.
From then on the buffer's ewoc is driven by notifications: `session/snapshot` replaces every node, `session/node` calls `ewoc-invalidate` on the node whose `index` matches or appends when no drawn node carries that index, `session/status` updates a mode-line segment showing streaming, compaction and model, and `session/renamed` re-keys the buffer's ref and renames the buffer.
`session/error` inserts a warning line at the tail; a `request` reported that way names the kind and does not imply the user can act on it, the same rule OW-nujawi set for the browser.

Follow behaviour: when point is at the end of the buffer before a redraw, keep it there after; otherwise leave it alone.
That is the whole of follow mode here and it is deliberately less than `App.svelte`'s, whose scroll anchoring exists for a browser viewport; Emacs windows do not need it.

## Composer

`agentpane-prompt` opens a small window below the transcript, a buffer in `text-mode` derived mode `agentpane-composer-mode`, the way `magit` and `with-editor` do for a commit message.
`C-c C-c` sends its contents through `sessions/prompt` and clears it, `C-c C-k` discards it, and `C-c C-a` aborts the turn from either buffer.
A prompt rejected mid-turn (D16) shows the server's text in the echo area and leaves the draft in place.
Images are out of scope for this card; `PromptRequest.images` exists on the wire and a later card may wire it.

`agentpane-compact` sends `sessions/compact`.

Owner, 2026-09-21: both of `agent-shell`'s prompt modes are handy in different cases -- typing at the bottom of the transcript buffer, and the separate composer buffer -- so this mode carries both, with `RET` inserting a newline and `C-RET` sending in either.
The composer above is the second; the first is a prompt region below the last node of the transcript buffer, editable while the rest stays read-only, sending through the same `sessions/prompt` path.

## New session and model

`agentpane-new-session` asks for a backend with `completing-read`, then a model from `models/list` for it, then `sessions/create` with the calling buffer's project directory as `cwd`, and opens the buffer attached.
`agentpane-set-model` is allowed only while the buffer has no nodes and forwards to `sessions/setModel`; otherwise it says the model is chosen before the first prompt.
The browser enforces the same gate in `src/client/controller.ts` `loadModelsForSelected`, the server does not, and the helper does not either (OW-refibu), so the mode enforces it.
Owner, 2026-09-13: choosing at conversation start is required, switching later is not.

## Done when

`ert` tests in `emacs/agentpane-test.el`, alongside OW-wavone's, drive the buffer with notifications through a stub connection and no process: a `session/node` for an existing index redraws that node in place and no other, one for the append index adds a node, a `session/renamed` re-keys the buffer, and `agentpane-set-model` on a buffer with nodes signals the gate's error without sending.
On the home server, against Codex (`-m gpt-5.6-luna` is the pin, though the model is chosen in the picker): create a session with a chosen model, send a prompt, watch the reply stream into the buffer, abort a second prompt mid-turn, and record it in `docs/MANUAL_TESTING.md` with versions.

## Amended 2026-09-22 at execution

The append rule read "appends when the index equals the count".
A node's `index` is its position in the session's flat message array, not in the node list (`src/emacs/protocol.ts`, "Replace by `index`, never by array position"), and the buffer holds no message count, so the rule is now: replace the node whose `index` matches, else append.
`projectUpsert` in `src/emacs/nodes.ts` answers a folded tool result with its owning call's node, so a result never arrives as a stray append.

The composer derived from `markdown-mode`.
That package is not installed on the home server, and Emacs 31.1's bundled `markdown-ts-mode` has no markdown grammar there (`treesit-language-available-p` answers nil), so the composer derives from `text-mode` and the mode takes no new dependency.

The model order: `agentpane-new-session` creates, attaches, then reads the model from `models/list` and sends `sessions/setModel` — still before the first prompt, and the browser's order.
Reading the model before `sessions/create` cannot work: `sessions/create` spawns nothing, and `listModels` in `src/server/http/app.ts` asks an unstarted adapter when no live one exists, which Codex refuses with "codex adapter not started" (measured 2026-09-22 against a fresh server).

## Landed 2026-09-22, live run outstanding

The code and the first done condition landed on `main` in 4b3f15f, 3417bd5, 34cc455 and cd6c245: `Ran 16 tests, 16 results as expected, 0 unexpected`, each new test shown red first.
The live run against Codex did not happen.
That session's sandbox mounted `~/.codex` read-only, and `codex app-server` exited at attach with `failed to initialize sqlite state runtime under /home/ark3/.codex`, though 8468a02 (OW-vowire) records the backend state dirs as normally read-write.
What remains is the second paragraph of "Done when", in a session whose sandbox can write `~/.codex`.
Findings from the adversarial read went to OW-yoyiya, OW-kisemu, OW-nuwive and OW-gunaza, none of which the live run waits on.
