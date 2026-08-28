/**
 * A read-only preview, in the shape the transcript already renders.
 *
 * Stored previews and attached sessions share the `Transcript` renderer. The
 * server has already mapped each backend's store records to message structure;
 * this client edge only converts the store-native ISO timestamp to the epoch-ms
 * shape the renderer consumes.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionPreviewTurn } from "$shared/protocol.ts";

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

export function previewMessages(turns: SessionPreviewTurn[]): AgentMessage[] {
	return turns.map((turn) => ({ ...turn, timestamp: turnEpoch(turn.timestamp) })) as AgentMessage[];
}
