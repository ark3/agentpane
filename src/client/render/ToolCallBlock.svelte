<script lang="ts">
	/**
	 * Registry lookup for a `toolCall` block (D5). Nothing else in the render
	 * tree knows tool names.
	 */
	import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
	import { resolveToolRenderer } from "./tools/registry.ts";

	let {
		call,
		result,
		streaming = false,
	}: {
		call: ToolCall;
		result?: ToolResultMessage | undefined;
		streaming?: boolean;
	} = $props();

	const Renderer = $derived(resolveToolRenderer(call.name));
</script>

<Renderer {call} {result} {streaming} />
