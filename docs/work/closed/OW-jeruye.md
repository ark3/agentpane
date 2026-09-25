---
labels: [change, emacs]
closed: done
---

# The Emacs helper converts and sends every streamed token of the tail message, about 34 session/node notifications a second on Haiku, where sending at most one per node every 250 ms would do

Owner, 2026-09-25: agentpane-mode gets laggy while a turn streams.
The owner chose the interval, 250 ms, on 2026-09-25; it is a first cut to be judged by use and tuned in a later card if it feels wrong, not something this card measures its way to.

## What a streamed token costs

Measured 2026-09-25 on the home server:
- A live `claude 2.1.280` `--model haiku` reply of about 400 words, 2,836 characters, arrived as 279 `upsert` events over 8.3 s, 34 a second, a median of 26 ms apart; each carried the whole message so far, the last one 4.4 KB.
  Codex and Pi were not measured.
- `onEvent`'s `"upsert"` case in `src/emacs/helper.ts` calls `projectUpsert` in `src/emacs/nodes.ts` for each one, which runs `buildTranscript` over the whole transcript and then renders every text part of the node from markdown: 6–12 ms per call on a 348-message stored Claude session with a tail message of about 3,900 characters, mostly the markdown.
- Each `session/node` reaches `agentpane--upsert` in `emacs/agentpane.el`, which `ewoc-invalidate`s the node and so redraws all of it -- shr for every text part, `agentpane--fit-header` for every tool and thinking header: 2–6 ms per call in batch Emacs for nodes of 2,600–8,300 characters, and a graphical frame measured roughly twice batch for `string-pixel-width` (OW-tujula).
  Redisplay after each redraw was not measured, since batch has none.
The browser already coalesces: D5's markdown throttle renders at most once per animation frame while streaming (`Block.svelte`, and the "Same coalescing Block.svelte uses for its markdown throttle" comment in `src/client/App.svelte`).
Nothing on the Emacs path does.

## The change

The helper sends at most one `session/node` per node per 250 ms while a session streams, and does the projection only for the node it sends, so both the markdown work and Emacs's redraws fall with the rate, about 34 a second to 4.
Load-bearing:
- Whatever else the helper writes goes after every node held back: any other notification for any session -- `session/snapshot`, `session/status`, `session/error`, `session/request`, `session/notice`, `session/renamed` -- a `session/node` at another index, and any JSON-RPC reply.
  Emacs relies on that order: `agentpane--set-status` redraws the tail when streaming ends, from the node it holds, and `agentpane--upsert` redraws the node before a newly appended one as no longer the pending turn.
  Flushing on those writes, rather than on the stream's own sequence, is the reading of this the card intends.
- What is held is keyed by the node the upsert projects to, not by the event's message index: a `toolResult` upsert is drawn into its owning assistant node, `projectUpsert`'s `owner` lookup.
  Whatever is sent reflects the latest state at the time it is sent.
- The last state of a turn always arrives: an upsert held when the stream goes quiet is sent when its interval ends, and the one before the `status` that ends streaming is sent before that status by the rule above.
- A session Emacs detaches or closes sends nothing more, held nodes included, as the existing "says nothing more after sessions/detach" and "after sessions/close" tests require.
- Whether the first upsert after a quiet interval goes out at once or waits out the interval is the implementer's call, stated in the close note.
D3's tail upsert is untouched: the server still broadcasts every token, and the browser is unaffected.
OW-luzipe, the whole message re-sent per token on the server's wire, and OW-nitima, Codex rebuilding its whole array per delta, are server-side and stay open.

## Done

Red first, then green, in `src/emacs/helper.test.ts`, with the interval driven by vitest's fake timers:
- many upserts to one node inside an interval produce one `session/node`, carrying the last state, and `projectUpsert` (or the render it calls) runs once for them, not once per upsert;
- an upsert held when a `status`, another node's upsert, or a reply is written arrives before it;
- a held upsert with nothing after it arrives when the interval ends;
- a held upsert for a session detached before the interval ends is never sent.
The existing test "opens the stream before the attach call, then yields one snapshot and one node per upsert, in order" is updated to the new contract rather than deleted.
`bun run check` passes.
A live run on the home server, a streamed Haiku reply of several hundred words through the helper, counts the `session/node` notifications it writes and finds them at no more than the rate 250 ms allows; that run goes into `docs/MANUAL_TESTING.md` with its version.

## Close note

Built: while a session streams, the Emacs helper (`src/emacs/helper.ts`) holds each `upsert` keyed by the node it projects to (a tool result under its call's node, via the new `locateUpsert` in `src/emacs/nodes.ts`) and sends what it holds from one 250 ms timer (`NODE_INTERVAL_MS`), rendering markdown (`projectTarget`) only for what it sends.
Every other write -- any notification for any session, any JSON-RPC reply -- goes through a `write` wrapper that flushes held nodes first, so Emacs's ordering assumptions hold.
Decisions the card left to the implementer: the first upsert after a quiet spell waits out the interval too (one timer, no second state); a held node is rendered from the transcript as it stood at its upsert, not the current state, which a snapshot moving the ref to a new handle would otherwise crash; held nodes go out in first-held order so a new node is never drawn ahead of an earlier one; detach, close and end of input drop held nodes.
`buildTranscript` still runs per upsert inside `locateUpsert`; only the rendering is deferred, which is what the done condition asked for.

Verified: 12 new or updated tests in `src/emacs/helper.test.ts` under the "the node throttle (OW-jeruye)" describe and the updated "opens the stream before the attach call..." test; all 9 original ones failed against the unchanged helper, and the three added after the adversarial read (cross-session order, captured transcript across a handle move, close by ref) each failed under a targeted mutation.
`bun run check` passes on main (1427 tests).
Live run on the home server, `claude 2.1.280` `--model haiku`, `bun 1.4.0`: 266 server upserts for the reply over 7.75 s became 28 `session/node`s, about 3.7 a second, every timer-driven gap at least 256.9 ms; recorded in `docs/MANUAL_TESTING.md`, "The Emacs helper's timer sends a streaming node at most once per 250 ms (OW-jeruye)".
Not observed: agentpane-mode itself; the live run drove the helper directly.
Filed from the review: OW-vejeka, a render that throws at flush now crashes the helper from the timer or fails a successful reply.
