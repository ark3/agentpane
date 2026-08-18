/**
 * A read-only preview, in the shape the transcript already renders.
 *
 * The server hands back text turns and nothing else (`SessionPreviewTurn`,
 * D11), so the preview used to have its own markup and its own CSS -- a second
 * renderer, which promptly drifted from the real one. Mapping the turns to
 * messages here instead means the preview and an attached session go through
 * the same `Transcript`, and there is one place role chrome lives.
 *
 * Only the assistant side needs anything invented. `provider` and `model` are
 * open unions, so they carry the backend id -- the one identity a preview
 * genuinely knows -- while `api` is a placeholder and the usage is zero, which
 * is also what suppresses the error banner and the token counts in
 * `Message.svelte`.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { BackendId, SessionPreviewTurn } from "$shared/protocol.ts";

const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A turn's timestamp is the record's own ISO string, or absent (OW-71). It
 * becomes `AgentMessage.timestamp`, a required epoch-ms `number`, so the one
 * ISO-to-epoch conversion sits here at the client edge -- the wire keeps the
 * ISO shape `SessionSummary` already uses, and nothing on the server has to
 * learn epoch-ms. An absent timestamp maps to `NaN`, not `0`: `formatTimestamp`
 * (via `new Date(NaN)`) renders `NaN` as the empty string, so a genuinely
 * timeless turn shows no time, where `0` would render the epoch as a real date.
 * `NaN` still keys the `{#each}` (`keyFor` stringifies it) stably per turn.
 */
function turnEpoch(iso: string | undefined): number {
	if (iso === undefined) return Number.NaN;
	const ms = new Date(iso).getTime();
	return Number.isNaN(ms) ? Number.NaN : ms;
}

export function previewMessages(turns: SessionPreviewTurn[], backend: BackendId): AgentMessage[] {
	return turns.map((turn) =>
		turn.role === "user"
			? { role: "user", content: turn.text, timestamp: turnEpoch(turn.timestamp) }
			: {
					role: "assistant",
					content: [{ type: "text", text: turn.text }],
					api: "session-preview",
					provider: backend,
					model: backend,
					usage: NO_USAGE,
					stopReason: "stop",
					timestamp: turnEpoch(turn.timestamp),
				},
	);
}
