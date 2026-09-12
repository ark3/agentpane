---
labels: [defect]
closed: done
---

# Reading view calls a tool-only transcript empty even though it is hiding existing output.

`src/client/render/transcript.ts`, `condense`; `src/client/render/Transcript.svelte`, the `view.entries.length === 0` empty branches; `src/client/render/Transcript.svelte.test.ts`.
OW-56 carried this as a smaller observation beside its browser-only follow-mode question, but it is an independently reachable rendering defect and does not belong behind that verification work.
A transcript can legitimately begin with an orphan `toolResult` after a fork or truncated history, and OW-reyale now lets a stored preview carry that same shape.
`buildTranscript` correctly renders the orphan in the full view, while `condense` deliberately removes every tool result; `Transcript.svelte` then sees zero entries and says `No messages yet.` even though Reading view is hiding content that exists.
The empty source state and the all-content-elided state must remain distinguishable so Reading view never reports that a nonempty transcript has no messages.
The exact reading-specific wording and whether the distinction lives on `TranscriptView` or is passed separately are incidental.
Done when a test in `src/client/render/Transcript.svelte.test.ts` renders a tool-result-only transcript in Reading view, fails first on the false empty-state claim, and passes with a reading-specific hidden-content state; toggling Reading view off in the same test restores the tool-result chrome.
`bun run check` passes; layout and browser timing are not involved, so `bun run test:browser` is not implicated.

## Close note

Reading view no longer claims an all-elided transcript is empty.

`condense` still drops every tool result, tool call and thinking block, so a transcript that is only an orphan `toolResult` -- legitimate after a fork or truncated history, and reachable through a stored preview since OW-reyale -- condensed to zero entries, and both empty branches in `Transcript.svelte` keyed off `view.entries.length === 0` alone.
The fix is in `Transcript.svelte` only: the two independent `{#if}` blocks became one chain led by `view.entries.length === 0 && fullView.entries.length > 0`, which renders `<p class="elided" data-reading-elided>` instead.
That condition is structurally false when reading is off, because `view` and `fullView` are then the same object.
It is gated on `!tailStatus` so the live reading-tail row still wins mid-turn.
An assistant turn that was only tool calls and thinking reaches the same branch, which was the same defect; the `stopReason === "error"/"aborted"` banner exception in `condense` keeps such a turn visible, so it never reaches it.

Verified: the new test "does not call a fully elided transcript empty (OW-pezero)" in `src/client/render/Transcript.svelte.test.ts` renders `orphanResult.slice(0, 1)` with `reading: true`, and was run against the pre-fix component -- red on `expected <p class="empty">No messages yet.</p> to be null` -- before going green.
Its second half rerenders with `reading: false` and asserts `roles(container)` is `["tool-result"]`, so the chrome is confirmed restored.
`bun run check` passes (49 files, 1024 tests, ~21s).
`bun run test:browser` not implicated: a text branch with no layout, scroll or Popover involvement.

Landed as bf323e7 on main.

Left for a verdict from use: the wording "Reading view is hiding this session's tool activity and thinking." is a first cut, and the card marked exact wording incidental.
Also noted and not changed -- when a turn is streaming, everything is elided and `readingTailStatus` returns undefined (e.g. an orphan result followed by an empty assistant placeholder), this branch now draws the elided line where "Waiting for the agent…" used to draw. That reads as the more accurate of the two and was left standing.
