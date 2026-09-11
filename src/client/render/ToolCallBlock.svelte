<script lang="ts">
	/**
	 * Registry lookup for a `toolCall` block (D5). Nothing else in the render
	 * tree knows tool names.
	 */
	import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
	import type { SessionRef } from "$shared/protocol.ts";
	import { resolveToolRenderer } from "./tools/registry.ts";

	let {
		call,
		result,
		streaming = false,
		onopensession,
	}: {
		call: ToolCall;
		result?: ToolResultMessage | undefined;
		streaming?: boolean;
		/** Open a session this tool names (OW-benige). Codex's subagent card is the only user today. */
		onopensession?: ((ref: SessionRef) => void) | undefined;
	} = $props();

	const Renderer = $derived(resolveToolRenderer(call.name));
</script>

<Renderer {call} {result} {streaming} {onopensession} />
