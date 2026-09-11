<script lang="ts">
	/**
	 * A Codex collab call -- the parent transcript's whole view of a subagent
	 * (OW-benige).
	 *
	 * One card per `spawnAgent` / `sendInput` / `resumeAgent` / `wait` /
	 * `closeAgent`, so the parent reads the lifecycle in sequence instead of
	 * pausing for minutes inside a `wait` with nothing on screen. The child's
	 * conversation is deliberately NOT inlined: it is a thread of its own, with
	 * its own rollout, and a nested transcript would bury the parent for as long
	 * as the subagent runs -- the confusion OW-fafeja removed. What is inlined
	 * is the one thing the parent was waiting for, the child's final message,
	 * which `wait` already carries.
	 */
	import type { SessionRef } from "$shared/protocol.ts";
	import type { ToolRenderProps } from "../types.ts";
	import { toolState } from "../types.ts";
	import { argString } from "./args.ts";
	import ResultBody from "./ResultBody.svelte";
	import ToolCard from "./ToolCard.svelte";

	let { call, result, streaming = false, onopensession }: ToolRenderProps = $props();

	/** The collab operation. `mapping.ts` always puts it here; every card is the same otherwise. */
	const tool = $derived(argString(call.arguments, "tool"));
	const prompt = $derived(argString(call.arguments, "prompt"));
	/**
	 * The child threads this call names. Empty on a spawn's `item/started` --
	 * Codex only reports the new thread's id on the completion -- so the card
	 * has to read as fine with none.
	 */
	const threadIds = $derived(
		Array.isArray(call.arguments["threadIds"])
			? call.arguments["threadIds"].filter((id): id is string => typeof id === "string")
			: [],
	);
	const state = $derived(toolState({ call, result, streaming }));
	const summary = $derived([tool, ...threadIds.map(shortId)].join(" · "));

	/** Enough of a uuid to tell two children apart without eating the summary line. */
	function shortId(id: string): string {
		return id.slice(0, 8);
	}

	function open(id: string): void {
		const ref: SessionRef = { backend: "codex", id };
		onopensession?.(ref);
	}
</script>

<ToolCard name={call.name} {summary} {state} timestamp={result?.timestamp}>
	{#if prompt}
		<p class="prompt">{prompt}</p>
	{/if}
	<!-- Unkeyed: `receiverThreadIds` is a bare `Array<string>` with no
	     uniqueness guarantee in the protocol, and a duplicate key throws in
	     Svelte 5 -- which would take down the whole transcript, not just this
	     card. Nothing here reorders, so a key would buy nothing anyway. -->
	{#each threadIds as id}
		<p class="thread">
			<span class="thread-id" title={id}>{id}</span>
			<!-- The handler is optional because `ToolRenderProps` is shared by
			     every renderer and most tools name no session. No stored-session
			     path reaches this card: `extractCodexPreviewTurns` names a stored
			     collab call after its namespace and function name, so a read-only
			     preview of the parent draws it on `DefaultTool` with no child
			     link at all. -->
			{#if onopensession}
				<button type="button" class="ap-action open-thread" onclick={() => open(id)}>
					Open thread
				</button>
			{/if}
		</p>
	{/each}
	<ResultBody {result} />
</ToolCard>

<style>
	.prompt {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--ap-fg-muted);
	}

	.thread {
		display: flex;
		align-items: baseline;
		gap: var(--ap-space-2);
		margin: 0;
		min-width: 0;
	}

	.thread-id {
		font-family: var(--ap-font-mono);
		font-size: var(--ap-text-xs);
		color: var(--ap-fg-subtle);
		overflow-wrap: anywhere;
	}
</style>
