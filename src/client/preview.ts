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
 * A stored turn has no timestamp -- the preview drops everything but the text.
 * It only feeds the `{#each}` key (`keyFor` in `render/transcript.ts`), which
 * already carries the index and the role, so a constant is enough and, unlike
 * a clock read, does not churn the key on every re-render.
 */
const NO_TIMESTAMP = 0;

export function previewMessages(turns: SessionPreviewTurn[], backend: BackendId): AgentMessage[] {
	return turns.map((turn) =>
		turn.role === "user"
			? { role: "user", content: turn.text, timestamp: NO_TIMESTAMP }
			: {
					role: "assistant",
					content: [{ type: "text", text: turn.text }],
					api: "session-preview",
					provider: backend,
					model: backend,
					usage: NO_USAGE,
					stopReason: "stop",
					timestamp: NO_TIMESTAMP,
				},
	);
}
