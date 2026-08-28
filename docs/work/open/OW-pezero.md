---
labels: [defect]
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
