---
labels: [change]
blocked-by: [OW-jamaha]
---

# A session-less Codex app-server, started after the list is already served, collects thread names and models the rollout walk cannot see

`src/server/http/session-manager.ts` (`list`, and where `sessions-changed` is emitted), `src/server/sessions/index.ts` (`listSessions`), `src/server/adapters/codex/adapter.ts` (the `initialize` and `model/list` requests, for shape), `src/shared/protocol.ts` (`SessionSummary.name`)

Codex keeps a thread's name outside the rollout file, so the D9 walk cannot see it however far it reads.
Measured on the home server 2026-09-15 with `codex-cli 0.154.0` (`docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire"): after two renames the rollout contained neither name, while `thread/list` reported the current one.
The owner's shape for this, stated the same day: serve the list from the walk as today, then start one `codex app-server` late, once the server is up and the list has already gone out, ask it for names, merge them in, and push the result.
"Deferred" describes when that process starts, not this card's label.

## What the one call returns

On 0.154.0, `thread/list` needs only `initialize` before it, takes `cwd` and cursor pagination (`resources/codex-protocol/v2/ThreadListParams.ts`), and answers rows carrying `id`, `name`, `model`, `cwd`, `preview`, `forkedFromId`, `updatedAt` and `path` to the rollout.
It answered for a thread whose `status` was `notLoaded`, so no thread is resumed and no writer lock is taken (OW-voyezi is the card on what does take one).
`model` is on the wire but not in the vendored `Thread.ts`; OW-wujuda carries that drift.
The same process can answer `model/list`, which is what `GET /api/models` has nothing to say to when no Codex session is attached (OW-21).
Collect models if it costs one more request, and say in the close note whether it did; wiring them into the picker is not this card's done condition.

## What has to exist

- One app-server the manager starts for itself, after startup has served its first list, with no thread of its own.
  It is a new kind of child: every Codex process today belongs to a session.
  D12's cap and reaper are about session processes, and this one is not counted among them; say so where those constants live.
- The merge: for each Codex summary the walk produced, the name from the matching `thread/list` row keyed by thread id, which is the rollout's `session_id` and the summary's `ref.id`.
- After the merge, the existing `sessions-changed` event, which the client already answers with a refetch; no new wire arm.
- The name is shown in the row in place of the preview, which the card this one is blocked on settles for every backend.

Load-bearing: the walk's list goes out first and is not delayed by this; the collector takes no writer lock on any thread; a collector that fails to start or answer degrades to today's list with the failure reported rather than logged (D13 has the `notice` arm for exactly this kind of session-less condition, and if OW-66 has not landed it, this is the second caller that justifies it).
Incidental, decide in flight and record: whether the collector runs once, on every `sessions-changed`, or on an interval; whether it stays up or exits after answering; and what happens to a name renamed from the Codex TUI after the collector ran, which stays stale until it runs again.

## Done when

Each watched red first.

1. A manager test with a fake app-server, built on `src/server/adapters/codex/test-support.ts`, serves a list, then answers `thread/list`, and asserts the Codex summaries carry names afterwards, a `sessions-changed` event was emitted after the merge, and the first list went out before the collector was asked anything.
2. A test where the fake refuses `initialize` asserts the list is unchanged, no thread was resumed, and the failure surfaced on the wire rather than only on stderr.
3. A test asserts a `thread/list` row with no matching walked summary changes nothing.

`bun run check` passes.
Then one live run on the home server against the real corpus, timed from server start to the merged `sessions-changed`, recorded in `docs/MANUAL_TESTING.md` with the version.
