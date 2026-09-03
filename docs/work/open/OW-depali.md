---
labels: [change]
---

# The composer has no way to hand its draft to an external editor and get the edited text back

The composer's textarea (`src/client/App.svelte:1193-1199`) is the only place to write a prompt, and there is no way to hand its contents to a real editor and get the edited text back.

## Grounding

`view.draft` (`src/client/controller.ts:22,368`) is the single source of truth for the composer's contents; `controller.setDraft(text)` is the only way to change it, and the textarea already binds both directions (`App.svelte:1195-1197`).

`handlePromptKeydown` (`App.svelte:1010-1019`) is bound directly on the textarea's `onkeydown`, not on `document`, which is what already makes Ctrl-Enter and Escape fire only when the composer is focused.
Ctrl-g is a new branch in that same function, not a new listener, and "only when the composer is focused" is therefore free -- do not add a `document`-level listener or a focus check, either would be new surface for a property the textarea binding already has.
Bind exactly `ctrlKey && key === "g"`; the owner asked for Ctrl-g specifically, not the Ctrl/Cmd pairing Enter uses, so do not add `metaKey` on your own judgment.

`.prompt-actions` (`App.svelte:1201-1249`) is the composer's action row.
The Tools popover trigger sits at `App.svelte:1209` (`<button class="tools-menu" popovertarget="tools-menu">Tools</button>`), immediately followed by the popover's own `<div id="tools-menu" popover ...>` (`1210-1226`), which participates in no layout since it renders in the top layer.
Owner decision 2026-09-03: a plain button reading "External Editor", sited immediately after the Tools button in that row (row order, not inside the popover) -- this is occasional-use like the popover's own entries, but frequent enough and single-click enough that the owner wants it outside the menu.

Server and browser are always the same machine (D8, `docs/DESIGN.md:206-217`, loopback-bind, no remote case), which is what makes "the server spawns the editor" reach the user's screen at all.
D7 (`docs/DESIGN.md:200-204`) is the *sandboxed* spawn path (`direnv exec <cwd> sbox -- <agent>`, `src/server/adapters/types.ts:46`) used for every agent subprocess; this feature's spawn is deliberately outside it, per the owner's "not sandboxed, to be sure" -- say so in a comment beside the new spawn call so a future reader doesn't assume it belongs on D7's path.

`docs/MANUAL_TESTING.md:61` runs the server backgrounded and detached (`bun run start >"$SERVER_LOG" 2>&1 &`), which has no controlling terminal -- confirmed in-shell, a process launched this way answers `tty` with "not a tty".
A curses editor (vim, nano, `emacs -nw`) spawned from such a process has nothing to draw into.
**Owner decision 2026-09-03: scope this to editors that return control without attaching to a terminal.**
Their own `$EDITOR` is `emacsclient`, which talks to an already-running Emacs over a socket and is exactly this shape -- build and verify against that, and do not add detection or a fallback for terminal-based editors; a `$EDITOR` that needs a tty is a known, out-of-scope gap, not a case to silently support or silently break worse than it already would.

Server routing: `src/server/http/app.ts:60-90` matches top-level routes (`/api/events`, `/api/models`) before falling into `sessionAction` (`:195-300`, reached only for `/api/sessions/:ref/:action` and requiring a `SessionRef`).
This feature touches no session or adapter, so it is a new top-level route (e.g. `POST /api/edit-draft`) beside `/api/models`, not a new `sessionAction` case.
Add its request/response pair to `src/shared/protocol.ts` beside `PromptRequest` (`:239`) -- `{ text: string }` in, `{ text: string }` out.

Client-side error surfacing already exists: `view.error` (`controller.ts:25`), set via `publish({ error: errorMessage(error) })` on a caught rejection (pattern at `controller.ts:393-394` etc.), rendered at `App.svelte:1122` (`<p class="error" role="alert">`).
Route a failed edit (missing `$EDITOR`, non-zero exit, whatever) through that same path -- no new error UI.
Gate re-entry the way other in-flight actions do: add `"editing-externally"` to the `busy` union (`controller.ts:24`) and disable the new button, and no-op Ctrl-g, while it holds.

## Round trip

1. Client (button click or Ctrl-g, guarded by `view.busy === "idle"`): POST `/api/edit-draft` with the current `view.draft`.
2. Server: write the text to a fresh temp file, spawn `$EDITOR` against it (through a shell, so an `$EDITOR` containing flags like `emacsclient -nw` still works -- this is the operator's own env var under D8's trust model, not browser input, so shelling out to it is not a new injection surface), await exit, read the file back, delete it in a `finally` regardless of exit code, respond with the contents.
3. Client: on success, `controller.setDraft(response.text)`; on failure, surface via `view.error` as above.

A `.txt` temp extension is a reasonable first cut; a `.md` one might make more sense of prompts that are often markdown-ish, but that is a nicety, not load-bearing -- pick one and leave a verdict-from-use note rather than building a way to configure it.

## Done when

Each test watched red first.

1. A server-side test (node project, alongside the other `src/server/http` route tests) points `$EDITOR` at a fixture script that deterministically rewrites the file it's given and exits 0, POSTs to the new route, and asserts the response reflects the rewritten content.
2. A server-side test with `$EDITOR` unset (or pointed at a script that exits non-zero) asserts the route answers an error response, using the same `error()` helper the other routes use (`app.ts`).
3. A client-side test (jsdom) asserts clicking "External Editor" POSTs `view.draft` and, on success, calls `controller.setDraft` with the response text -- and on the server error case, sets `view.error` instead.
4. A client-side test dispatches a `ctrlKey`+`"g"` keydown on the textarea and asserts it takes the same path as the button; the same keydown dispatched on `document.body` (composer not focused) asserts no request is made, proving the scoping is inherent rather than asserted separately.
5. `bun run check` passes.

No browser-testing label: nothing here touches scroll, follow mode, or layout that jsdom can't see -- a focused-element keydown and a button click are both real in jsdom.
