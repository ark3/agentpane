---
labels: [defect]
---

# The Pi preview stamps each turn with its entry's append time, not the message's own timestamp, so an assistant footer reads up to its turn's length later than live

Filed 2026-10-14 by the execution of OW-piyulu, from the adversarial read of its `pi 1.2.0` captures.

Live, an assistant turn's footer shows `formatTimestamp(turn.timestamp)` (`src/client/render/Message.svelte`), and `turn.timestamp` is the message's own epoch-ms `timestamp`, which Pi stamps when the message starts.
Stored, Pi writes the same message inside a `type: "message"` entry whose own ISO `timestamp` is when the entry was appended, at the message's end, and the message keeps its own epoch inside it.
`storedAgentMessage` in `src/server/sessions/preview-message.ts` discards the message's own value (`const { timestamp: _storedTimestamp, ...stored } = value`) and `extractPreviewTurn` in `src/server/sessions/pi.ts` hands it the entry's instead.
In `resources/fixtures/pi/compact-session.session.jsonl` the first assistant message's own timestamp is 22:13:49.797Z and its entry's is 22:14:02.371Z, so the same turn reads 22:13:49 live and 22:14:02 in the preview; the second reads 22:14:02 against 22:14:17, and `tool-read-session`'s two differ by about a second each.
User and tool-result messages agree to within milliseconds, because they are appended as they start.

In service of the preview reading as the live transcript of the same run does.
`src/client/preview.ts`, "A turn's timestamp is the record's own ISO string, or absent (OW-71)", is the decision the preview's timestamps rest on; read it before choosing whether "the record" for a Pi message is the entry or the message, and say which in the docblock that changes.
The time drop came in with OW-reyale (`0f3a3eb`, "Render rich stored-session previews"); whether it was chosen for a reason, such as a Pi version whose messages carried no timestamp, is unknown, and a message without its own timestamp still needs one, so the entry's stays the fallback.

## Done when

`src/server/sessions/pi-conformance.test.ts`'s projection carries each row's timestamp, as the footer would render it or as the epoch, and its header's sentence saying timestamps are left out, which names this card, is gone; with the fix absent the test fails on the assistant rows of both scenarios, and with it the table lists no timestamp difference.
A unit test in `src/server/sessions/pi.test.ts` asserts that an assistant message carrying its own `timestamp` keeps it in the preview, and one without it takes the entry's, red before the fix where it can be.
`bun run check` passes.
