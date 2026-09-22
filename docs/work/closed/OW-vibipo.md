---
labels: [question, emacs]
closed: done
---

# Which Emacs client agentpane builds, agent-shell over an ACP shim or a native mode over its own JSON-RPC helper, is undecided and closes as D22

Filed 2026-09-15.
Two streams of cards now describe an Emacs client, and nothing records which one the project is building.

- `agent-shell` over an ACP shim: OW-fenobo, OW-basoga, OW-limejo, with OW-mikuyo deferred behind it.
  Its case, in OW-basoga: no Emacs rendering is written, and every fork and session fact stays agentpane's.
- A native `agentpane-mode` over a JSON-RPC helper agentpane owns: OW-mutufa, OW-refibu, OW-wavone, OW-gunuke, OW-fojike.
  Its case, in OW-mutufa: the owner used `agent-shell` and found the fit costs more than it saves, and a protocol agentpane owns has a field for everything ACP had to smuggle, chiefly the fork point, the model gate and `request` events.

OW-wawipu belongs to neither stream and stands whichever is chosen.

The two streams share their first module in all but output type, so the cost of deciding late is small until either stream's second card starts.
Both may also be explored: the reader who has used both for a week is the one this card is written for, and a rough cut of each is what the owner's practice for UI decisions asks for; this line pointed at D14's history when filed, which records no such thing, corrected 2026-09-22.

## Fork is not a differentiator between the streams

Measured 2026-09-21 by reading the installed `agent-shell` at 7377ba8 and `acp.el` 0.15.1 against `src/shared/protocol.ts`, then against the shim cards.

OW-mutufa's case names the fork point first among what ACP has to smuggle, and the raw protocol bears that out: `acp-make-session-fork-request` sends `sessionId`, `cwd`, `mcpServers` and `_meta` and nothing else, so ACP's own fork has no point and `agent-shell-fork` branches from the tip.
Its forked buffer also renders no history, because the replay machinery is wired to `session/resume` and `session/load` only.

But OW-limejo already answers this, and answers it well: `_meta.agentpane.entryId` on `session/fork`, with the points fetched through an `_agentpane/forkPoints` extension method and offered in a `completing-read`.
`_meta` is the field ACP provides for exactly this, `agent-shell-fork` keeps working from the tip unmodified, and the cost is one command in `emacs/agentpane.el`.
So the fork point is not smuggled so much as carried in the envelope ACP has for it, and this card should not be decided on fork.
The model gate and `request` events are untouched by this reading and remain OW-mutufa's case.

Two things to keep whichever stream wins.
The fork point must come from `/fork-points`, never counted from the buffer, which OW-limejo already does: `agent-shell-ui-state` at point yields `:namespace-id`, which is `shell-maker`'s buffer-local request counter, and `ForkPoint.index`'s docblock records that counting user messages was already falsified by Codex steering and failed silently.
A picker over the points is also the only shape that can decline to fork on a message no point names.

## What the shim cards do not yet cover

The rest of the ACP mismatch is already answered -- OW-basoga re-keys on `renamed`, re-snapshots on a `seq` gap, enforces the model gate itself, serves `session/load` from `GET .../preview` so preview costs no Emacs rendering, and puts the backend on the shim's command line so one `agent-shell` config per backend carries what `SessionRef` carries.
Four gaps remain, and they are the shim stream's real cost rather than fork:

- Compaction.
  `compaction: "requesting" | "running" | null` rides on `snapshot` and `status`, and ACP has no compaction method or state; a slash command loses the state signal.
- `sessions-changed`.
  A server push that the list changed has no ACP carrier, because ACP notifications are session-scoped, so Emacs would poll.
- `status` and `isStreaming` in the list.
  ACP's session entries have no field for either -- `agent-shell` reads `sessionId`, `title`, `cwd`, `updatedAt` and `createdAt` -- so the shim's list cannot show which sessions are live or attached, which `SessionSummary` exists to show.
- `issuerThreadId`, which routes a spawned Codex child's blocking request through the parent adapter, and `AssistantTurn.effort`.

## The trial narrowed the question to rendering

Owner, 2026-09-21, after some days on `agent-shell` bare, without the shim.
What was missed was the fast session list and fork, which the shim cards would restore, so the trial stands as a fair test of the shim route with those two back.
What was disliked was the rendering, which the shim cannot touch, and which by then had needed significant tuning to look okay.
The interaction model the owner likes -- staying in Emacs, Magit and back, long messages edited in place, `RET` and `C-RET`, inline prompt or separate composer -- is Emacs's, not `agent-shell`'s, and a native mode carries it at the cost of a keymap.
So the streams now differ on rendering alone, and OW-dekate is the rough cut that answers it: its verdict is recorded here under a dated heading before this card closes.

## Rendering verdict, 2026-09-22

OW-dekate ran on the work laptop over two evenings, 2026-09-21 and 2026-09-22, the owner at a live Emacs 31.1.50 beside the browser, the agent editing `emacs/agentpane-spike.el` on `main` and redrawing through `emacsclient`.
Two stored sessions were dumped through `src/emacs/dump-nodes.ts`: `claude/a4caf4c9-5567-4718-a77e-984ebe319b4e`, with Edit diffs and a markdown table, and `codex/01a0c449-2767-73e2-8b2b-dd67cf4d6c1a`, with fenced shell.
The rounds are the commits from da83c81 to 2e50164.

**The backend is shr, drawing the browser's own HTML.**
The dump script writes beside each text part the exact sanitized string `renderMarkdown` in `src/client/render/markdown.ts` returns, under a jsdom window, and the spike hands that to `shr` with filling off so `visual-line-mode` wraps it.
The owner's words: "this approach using shr is absolutely 100% a success".

What the markdown-mode backend got, over four rounds, and what it could not: proportional wrapped prose at the owner's markdown-buffer size, hidden markup, hanging indents for lists, code and diffs monospace, and the browser's layout of turns; but a table is aligned monospace source, and a wide one wraps at the window edge into nothing readable.
That was the owner's remaining objection to it, and it is the case shr exists for.

What shr got right: headings at the stylesheet's three ratios and weight, inline code and fenced code at the code size on the browser's tints, highlight.js token classes mapped to font-lock faces so fenced code is coloured by role, and tables as real columns fitted to the window in proportional text at a smaller size, cells folding inside their own column.
Everything the markdown-mode rounds had settled carries over unchanged: assistant turns plain on the page closed by one small meta line, user turns on the dark theme's raised surface with its accent bar, tool and thinking parts folded behind a summary line, signature-only thinking drawn as nothing.

What shr got wrong and the owner accepted: numbered lists read `1 ` rather than `1.`, which is shr's list drawing.
What was tuned rather than accepted: the stylesheet's exact table ratio landed on 14px under 18px prose and read too small, so the face says 0.95, which is the 16px step between the code size and the prose; a raised surface behind table header cells was tried and removed as not fitting the look.

Three Emacs facts the code records where it works around them, each measured on 31.1.50: `shr-tag-table` sets `truncate-lines` in the buffer it draws into; `shr-tag-pre` binds the current font to `default`, so block code comes out without `shr-code`; and `fixed-pitch` carries no height of its own, so under a proportional buffer face it inherits the prose size and has to be pinned to the default face's absolute height.
A fourth is about the loop itself: `defface` does not redefine an existing face on reload, so a face change reaches a running Emacs only after its `face-defface-spec` is cleared.

What this decides: the streams differed on rendering alone, and a native buffer can now draw closer to the browser than tuned `agent-shell` does, from HTML the browser already produces.
The native stream is the one to build, and D22 is this card's own act under "Done when".
The card said D21 when filed, but D21 was taken by the reconnect re-list decision (OW-vukoku, 2026-09-16) before this one was written; amended 2026-09-22 at execution.
OW-wavone's Drawing list was rewritten in the same change to name shr and the HTML it needs; that HTML is a field the helper has to send beside each text part, which OW-refibu's `sessions/preview` and `session/node` do not yet say.

## Done when

The decision is recorded in `docs/DESIGN.md` as D22, with the reason, on the same day the other stream's open cards close `--declined` citing D22.
The closing act also writes the sentence OW-basoga planned for D14, scoping it to the browser client, since it is true of both streams.

## Close note

Decided 2026-09-22: the Emacs client is a native `agentpane-mode` over a JSON-RPC helper agentpane owns, recorded as D22 in `docs/DESIGN.md` (D21 had been taken by OW-vukoku, so the number this card was filed with moved by one).
The evidence is OW-dekate's rendering spike and its verdict under "Rendering verdict, 2026-09-22" above: the streams had narrowed to rendering alone, and an `shr` buffer over the browser's own HTML settled it.
The same day OW-fenobo, OW-basoga, OW-limejo and OW-mikuyo closed `--declined` citing D22, D14 gained the sentence OW-basoga planned scoping the pointer rule to the browser client, `AGENTS.md`'s label notes now say which stream was chosen, and OW-refibu was amended to send the `html` field beside each text part that OW-wavone's Drawing list needs.
Reviewed by a dispatched adversarial reader before commit; its findings, chiefly that D14 carries no "rough cut" history despite this card and OW-dekate citing one, were fixed in the same change.
