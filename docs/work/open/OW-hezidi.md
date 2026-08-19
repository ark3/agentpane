---
kind: change
where: '`src/client/render/Message.svelte` user arm (`:67-78`), `src/client/render/Block.svelte`, `src/client/api.ts`, `src/client/controller.ts`, `src/client/App.svelte` composer (`:826-856`)'
---

# A user message cannot be taken back, so a mis-sent prompt still costs a real turn in both directions and the server's fork has no caller at all.

The server half is built and live-verified on both backends -- routes at
`src/server/http/app.ts:247` and `:276`, `SessionManager.fork` absorbing the
two backends' asymmetry, both adapters -- while
`rg 'forkPoints|ROUTES.fork' src/client/` returns nothing. This item is the
client half, and it is the whole of what stands between a working fork and a
feature nobody can reach.

**Two stale pointers to fix in this change.** `BlockActions.svelte`'s docblock
ends *"Read-only, deliberately -- edit and resubmit is OW-22"*, and closed
OW-63 says *"Deliberately read-only: no edit/resubmit (blocked on OW-22)"*.
OW-22 closed having settled what a fork's returned ref means and never
discusses resubmitting, so both pointers now send a reader somewhere that does
not answer them. Redirect them here.

## The gesture

Specified by the owner on 2026-08-19. The motivation is closed OW-73's
mis-sent draft, which *"costs a real turn in both directions and cannot be
rewound"*.

An **edit** button on every user message. Clicking it fills the composer with
that message, marks it in the transcript, and dims everything after it.
Nothing has happened yet -- no request, no server state -- so the click is free
and abandonable, and that property is what the rest of this design is built to
protect. Submitting forks the session at that message, sends the edited text
into the fork, and leaves you selected and attached to it. The original session
stays intact in the list.

**Always a new session, never an in-place rewind.** One outcome to learn
instead of two, and it is the one both backends can actually produce (closed
OW-mewiga, finding 46: Codex cannot rewind in place at all).

**The dimmed tail, rather than hiding it.** CC, Codex and Pi Agent all drop the
messages after the fork point from view; dimming keeps them readable while
saying the same thing, because the usual reason to rewrite a message is that
the reply misread it and you want that reply in front of you as you reword.
What the dimming must not be is ambiguous: with the whole conversation
undimmed there is nothing on screen distinguishing "this composer will fork at
message 5" from "this composer will append here", and those outcomes differ by
a whole session. If dimming proves to read as ambiguous in use, collapsing to
the CC behaviour is a small change and is the intended fallback -- this is a
first cut to get a verdict from, not a settled end state.

Once the fork is submitted the original session reads **normal**: the mark is
composer state, not a property of the session, and nothing records "you
branched here" (owner, 2026-08-19).

## What the button says

The primary button names every consequence it is about to have -- the owner's
requirement, in his words, *"I don't want to be surprised by this"*:

| state | label |
|---|---|
| idle, not editing | Send |
| streaming, not editing | Send, beside today's Abort (`App.svelte:853`) |
| idle, editing | Fork |
| streaming, editing | Abort and fork |

Submitting an edit while a turn runs aborts it first, on both backends. That is
a first cut chosen because it is safe on both; not aborting on Codex, where the
parent thread genuinely keeps running, is a later refinement gated on
OW-yudoni.

The last row is reachable only one way -- scrolling up and hitting edit while a
turn runs -- and it is unstable: if that turn finishes while you are still
typing, the label reverts to "Fork" under your cursor. Deliberate. The
alternative, aborting at edit-*click* rather than at submit, was considered and
rejected: it would mean clicking edit to re-read your own wording and thereby
killing a running turn, which destroys the free abandonable click above.

## Addressing the fork point

`ForkPoint.id` is a Pi entry id or a Codex turn id, and `PaneMessage` carries
no id. `protocol.ts` is D11-frozen -- do not add one. The nth user message in
the transcript is the nth entry from `GET .../fork-points`, and
`App.svelte:798-801` already enumerates user messages for its previous/next
navigation, so reuse that ordering rather than matching on message text, which
two identical messages break.

The client asks to fork **at** message N, meaning the new session ends just
before it. Honouring that against a backend whose primitive is off by one is
the adapter's job and not the client's: `codex/adapter.ts:398` already passes
`turnOrder[index - 1]`, because `lastTurnId` is inclusive. Whether Pi's `fork`
needs the same shift is OW-yudoni, and settling it moves one line in
`pi/process.ts` and nothing here.

## Constraints that will bite

- **Images.** `Message.svelte:37` shows a user message's content is
  `string | (TextContent | ImageContent)[]`, and `PromptRequest.images` can
  carry them back. Restoring the text alone silently changes what is sent,
  which is the surprise the button labels above exist to prevent. Carry them,
  or say plainly that they are being dropped -- not silence.
- **A user message leading with an image has no row to hang the button on.**
  `Block.svelte:49` draws `BlockActions` only for a text block with non-empty
  trimmed text, and `Message.svelte:74` offers message-level facts to the first
  block alone so they cannot render twice. Follow that pattern, and decide what
  happens when the first block is not text.
- **An existing draft is clobbered.** Hitting edit with something already typed
  loses it. Stash it and restore on cancel.
- **The backends reach "attached to the fork" from opposite directions.** Pi's
  fork moves the live process onto the new file and `SessionManager.fork`
  re-keys, emitting `renamed`, which `App.svelte` already handles through
  `controller.onRename`. Codex leaves the current adapter on the parent, and
  the returned ref has no adapter at all, so the client must attach it. Both
  paths must end selected and attached.

## Load-bearing versus incidental

Load-bearing, all settled by the owner on 2026-08-19: the edit click is free
and abandonable, the fork happens at submit rather than at click, the outcome
is always a new session, the button names every consequence it will have, and
the original session reads normal afterwards.

Incidental, decide in flight: the button's glyph and wording, how the mark on
the edited message is drawn, how the dimmed tail is styled, and whether cancel
is a button or Escape.

Out of scope: any view of a session's branches, and anything that hides or
groups the sessions forking multiplies (OW-66, OW-vezipo).

## Done when

Each test watched red first.

1. Clicking edit on a user message issues no request, fills the composer, and
   marks that message -- a client test asserting all three.
2. Submitting an edit calls fork with the point for that message and *then*
   prompts into the returned ref rather than the original. Assert both calls
   and their order.
3. A Codex-shaped fork -- returned ref differs, no `renamed` -- ends selected
   and attached to the returned ref.
4. A Pi-shaped fork -- `renamed` arrives -- ends selected on the new ref with
   the scroll and follow maps re-keyed.
5. The primary button reads "Fork" when editing and idle and "Abort and fork"
   when editing and streaming, and follows a turn completing mid-compose.
6. Editing a message that carries an image does not silently send fewer images
   than the original held.

`bun run check` passes, and so does **`bun run test:browser`**: this changes
the message footer rows under `src/client/render/`, which AGENTS.md names as a
case jsdom cannot see.
