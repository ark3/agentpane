<script lang="ts">
	/**
	 * Role chrome. Everything inside a message is a content block, so this
	 * component only decides how the message *frame* looks (D5) and hands the
	 * blocks to `Block.svelte`.
	 *
	 * `PaneMessage` is `AgentMessage` with the assistant arm widened by the
	 * fields this repo adds. It is open by construction -- `AgentMessage` is
	 * `Message | CustomAgentMessages[keyof CustomAgentMessages]`, and a backend
	 * can declaration-merge new kinds in. The final `{:else}` is therefore not
	 * dead code: a kind nobody merged in still reaches it at runtime, which is
	 * how Pi's system-role message arrived as a JSON dump until it got an arm
	 * of its own (OW-wavini).
	 *
	 * A system message draws as a one-line marker naming what it carries, with
	 * its text behind a native disclosure, collapsed: a first cut chosen by the
	 * owner on 2026-10-14, to be judged in use. What the marker says and what
	 * the disclosure holds is `systemView` in `./system.ts`, which the Emacs
	 * projection shares, and its docblock carries the decision whole.
	 */
	import type { ToolResultMessage } from "@earendil-works/pi-ai";
	import type { AssistantTurn, PaneMessage, SessionRef } from "$shared/protocol.ts";
	import { formatTimestamp, timestampIso } from "../time.ts";
	import Block from "./Block.svelte";
	import type { ContentBlock } from "./types.ts";
	import { oneLine, resultText, userBlocks } from "./types.ts";
	import { systemView } from "./system.ts";
	import Output from "./tools/Output.svelte";
	import ResultBody from "./tools/ResultBody.svelte";
	import ToolCard from "./tools/ToolCard.svelte";

	let {
		message,
		results = new Map<string, ToolResultMessage>(),
		streaming = false,
		index,
		editing = false,
		dimmed = false,
		leading = false,
		onedit,
		onopensession,
	}: {
		message: PaneMessage;
		results?: Map<string, ToolResultMessage>;
		streaming?: boolean;
		/** Position in the original `messages` array (OW-27: lets the shell find a specific message's DOM node, e.g. to anchor follow-mode). Omitted, no `data-index` renders. */
		index?: number;
		/** This user message is the one the composer is editing (OW-hezidi). */
		editing?: boolean;
		/** This message sits after the edit point, so it is not where the composer will send (OW-hezidi). */
		dimmed?: boolean;
		/** This system message is the transcript's first, the system prompt every later one changes (OW-wavini). */
		leading?: boolean;
		/** Offer an edit control on this user message. Absent -- a preview, or any other role -- and none is drawn. */
		onedit?: ((index: number) => void) | undefined;
		/** Open a session a tool block names (OW-benige). Passed to every assistant block; only the subagent card uses it. */
		onopensession?: ((ref: SessionRef) => void) | undefined;
	} = $props();

	/**
	 * Which block's action row carries the edit control (OW-hezidi), or -1.
	 *
	 * `Block` draws an action row only for a text block with something in it, so
	 * a user message that leads with an image has no row on its first block and
	 * the control goes to the first block that does have one. A message with no
	 * text at all gets none: there would be nothing to put in the composer.
	 */
	function editRowIndex(blocks: ContentBlock[]): number {
		return blocks.findIndex((block) => block.type === "text" && block.text.trim() !== "");
	}

	/** A finished turn with something to report: the model, the accounting, or both. */
	function showsMeta(turn: AssistantTurn): boolean {
		return turn.stopReason !== "pending" && (Boolean(turn.model) || turn.usage.totalTokens > 0);
	}

	/**
	 * Which block's action row carries the turn's meta, or -1 for none (OW-75).
	 *
	 * The turn's footer facts and the trailing block's copy/expand buttons are
	 * one row, the way a user turn's already are -- but only where there is a
	 * row to merge with, so the change can never *add* a row. A turn ending in a
	 * tool call, a thinking block or an image has no action row there and keeps
	 * its meta standalone; a pending turn has no meta and keeps a bare button
	 * row. An earlier text block in a multi-block turn keeps a bare row too:
	 * good enough for now, not the end state.
	 */
	function metaRowIndex(turn: AssistantTurn): number {
		if (!showsMeta(turn)) return -1;
		const last = turn.content.at(-1);
		// `Block` draws the row only once the block has something to copy.
		return last?.type === "text" && last.text.trim() ? turn.content.length - 1 : -1;
	}

	const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
</script>

{#if message.role === "user"}
	{@const blocks = userBlocks(message.content)}
	{@const editRow = editRowIndex(blocks)}
	<article class="msg user" class:editing class:dimmed data-role="user" data-index={index}>
		<div class="body">
			<!-- When the message happened is a fact about the *message*, but a user
			     message is effectively one text block, so it rides the first block's
			     action row (OW-63) rather than growing a meta row of its own. Only
			     the first block is offered it, so it can never render twice. The
			     edit control (OW-hezidi) is the same bargain and rides the same row,
			     but it goes to the first block that *has* one. -->
			{#each blocks as block, i (i)}
				<Block
					{block}
					{results}
					timestamp={i === 0 ? message.timestamp : undefined}
					onedit={onedit && index !== undefined && i === editRow ? () => onedit(index) : undefined}
				/>
			{/each}
		</div>
	</article>
{:else if message.role === "assistant"}
	<!-- `turn` is `message`, narrowed, as a const: the narrowing has to survive
	     into the `meta` snippet, and TypeScript drops it for a `let` inside a
	     closure. -->
	{@const turn = message}
	{@const metaIndex = metaRowIndex(turn)}
	<!-- The model and the accounting are separate facts: a finished turn can
	     report no usage (a synthesised preview turn, or a provider that sends
	     none) and still know which model answered. -->
	{#snippet meta()}
		{@const time = formatTimestamp(turn.timestamp)}
		<p class="meta">
			<!-- Absolute and UTC, byte-identical to the session list's (OW-67):
			     the same formatter, so the two can never drift apart. -->
			{#if time}
				<time datetime={timestampIso(turn.timestamp)}>{time}</time>
			{/if}
			{#if turn.model}
				<span>{turn.model}</span>
			{/if}
			<!-- Effort is a property of the model that answered, so it sits with
			     the model. Only Codex reports one (OW-61); absent, nothing shows. -->
			{#if turn.effort}
				<span>{turn.effort}</span>
			{/if}
			{#if turn.usage.totalTokens > 0}
				<span>{compact.format(turn.usage.totalTokens)} tok</span>
				{#if turn.usage.cost.total > 0}
					<span>${turn.usage.cost.total.toFixed(4)}</span>
				{/if}
			{/if}
		</p>
	{/snippet}
	<article class="msg assistant" class:dimmed data-role="assistant" data-index={index}>
		<div class="body">
			{#each turn.content as block, i (i)}
				<Block
					{block}
					{results}
					meta={i === metaIndex ? meta : undefined}
					streaming={streaming && i === turn.content.length - 1}
					{onopensession}
				/>
			{/each}

			{#if streaming && turn.content.length === 0}
				<span class="cursor" aria-label="thinking">●</span>
			{/if}
		</div>

		{#if turn.stopReason === "error"}
			<p class="banner error" role="status">
				{turn.errorMessage || "The turn ended in an error."}
			</p>
		{:else if turn.stopReason === "aborted"}
			<p class="banner aborted" role="status">Aborted.</p>
		{/if}

		<!-- No trailing action row to ride, so the meta keeps a row of its own. -->
		{#if metaIndex === -1 && showsMeta(turn)}
			{@render meta()}
		{/if}
	</article>
{:else if message.role === "toolResult"}
	<!-- An orphan: the call it answers is not in this transcript slice. -->
	<article class="msg tool-result" class:dimmed data-role="tool-result" data-index={index}>
		<ToolCard
			name={message.toolName}
			summary={oneLine(resultText(message)) || "result"}
			state={message.isError ? "error" : "ok"}
			timestamp={message.timestamp}
		>
			<ResultBody result={message} />
		</ToolCard>
	</article>
{:else if message.role === "compactionSummary"}
	<!-- One renderer for every backend (OW-72): always a marker, plus the summary
	     text and token figure only when the backend supplied them. Codex's
	     contextCompaction carries neither, so it draws as a bare marker -- the
	     normal path, not a fallback -- while Pi's carries both. -->
	<article class="msg compaction" class:dimmed data-role="compactionSummary" data-index={index}>
		<p class="compaction-marker">
			<span class="compaction-rule" aria-hidden="true"></span>
			<span class="compaction-label">
				Context compacted{#if message.tokensBefore > 0}
					<span class="compaction-tokens">from {compact.format(message.tokensBefore)} tok</span>
				{/if}
			</span>
			<span class="compaction-rule" aria-hidden="true"></span>
		</p>
		{#if message.summary}
			<div class="body">
				<Block block={{ type: "text", text: message.summary }} {results} />
			</div>
		{/if}
	</article>
{:else if message.role === "system"}
	{@const system = systemView(message, leading)}
	<article class="msg system" class:dimmed data-role="system" data-index={index}>
		<details>
			<summary class="system-marker">{system.summary}</summary>
			<div class="system-body">
				{#if system.content.trim()}
					<pre class="system-text">{system.content}</pre>
				{/if}
				{#each system.sections as section (section.name)}
					<section data-section={section.name} data-removed={section.text === null ? "" : undefined}>
						<h4 class="system-label">{section.name}</h4>
						{#if section.text === null}
							<p class="system-removed">removed</p>
						{:else}
							<pre class="system-text">{section.text}</pre>
						{/if}
					</section>
				{/each}
				{#if system.toolsAdded.length > 0}
					<section>
						<h4 class="system-label">tools added</h4>
						<dl>
							{#each system.toolsAdded as tool (tool.name)}
								<div data-tool-added={tool.name}>
									<dt>{tool.name}</dt>
									<dd>{tool.description}</dd>
								</div>
							{/each}
						</dl>
					</section>
				{/if}
				{#if system.toolsRemoved.length > 0}
					<section>
						<h4 class="system-label">tools removed</h4>
						<ul class="system-removed-tools">
							{#each system.toolsRemoved as name (name)}
								<li data-tool-removed={name}>{name}</li>
							{/each}
						</ul>
					</section>
				{/if}
			</div>
		</details>
	</article>
{:else}
	<article class="msg unknown" class:dimmed data-role="unknown" data-index={index}>
		<Output text={JSON.stringify(message, null, 2)} language="json" />
	</article>
{/if}

<style>
	.msg {
		display: flex;
		flex-direction: column;
		gap: var(--ap-space-2);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: var(--ap-space-3);
		min-width: 0;
	}

	/* The user's own words are the landmark you scan for, so they get the one
	   filled surface in the transcript. Everything else sits on the page. */
	.user {
		align-self: flex-start;
		max-width: min(100%, 62ch);
		padding: var(--ap-space-3) var(--ap-space-4);
		background: var(--ap-surface-raised);
		border: 1px solid var(--ap-border);
		border-left: 2px solid var(--ap-accent);
		border-radius: var(--ap-radius-lg);
	}

	/* The tail after the edit point, dimmed rather than hidden (OW-hezidi). CC,
	   Codex and Pi Agent all drop it from view; keeping it readable is the point,
	   because the usual reason to reword a message is that the reply misread it
	   and you want that reply in front of you while you reword. */
	.msg.dimmed {
		opacity: 0.4;
	}

	/* The message the composer is currently editing. Composer state, not a
	   property of the session: once the fork is submitted this is gone and the
	   original session reads normal. */
	.msg.user.editing {
		border-color: var(--ap-accent);
		box-shadow: 0 0 0 1px var(--ap-accent);
	}

	.banner {
		margin: 0;
		padding: var(--ap-space-2) var(--ap-space-3);
		border-radius: var(--ap-radius-md);
		font-size: var(--ap-text-sm);
	}

	.banner.error {
		background: var(--ap-danger-soft);
		color: var(--ap-danger);
	}

	.banner.aborted {
		color: var(--ap-fg-subtle);
		padding-left: 0;
	}

	.meta {
		display: flex;
		/* Centred, not stretched: in a block action row this box is as tall as the
		   buttons beside it, and the facts have to sit on their line. */
		align-items: center;
		gap: var(--ap-space-3);
		margin: 0;
		font-size: var(--ap-text-2xs);
		color: var(--ap-fg-subtle);
		font-variant-numeric: tabular-nums;
		/* Takes the left end of the row and pushes the block's buttons right, the
		   way `.time` does for a user turn. No effect standalone -- the facts are
		   left-aligned either way. */
		margin-right: auto;
		/* The action row sets `user-select: none` so its button glyphs stay out of
		   a copy of the block. The token count and the cost are facts a reader
		   quotes, not chrome, so they opt back in. */
		user-select: text;
	}

	/* A compaction marker reads as a divider, not a message: it is the seam the
	   context was folded at, so it spans the column with a centred label rather
	   than sitting in a bubble. The summary (Pi) rides below it as ordinary prose;
	   Codex draws the marker alone. */
	.compaction-marker {
		display: flex;
		align-items: center;
		gap: var(--ap-space-3);
		margin: 0;
		color: var(--ap-fg-subtle);
		font-size: var(--ap-text-2xs);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.compaction-rule {
		flex: 1;
		height: 1px;
		background: var(--ap-border);
	}

	.compaction-label {
		display: inline-flex;
		gap: var(--ap-space-2);
		align-items: baseline;
		white-space: nowrap;
	}

	.compaction-tokens {
		font-variant-numeric: tabular-nums;
		text-transform: none;
		letter-spacing: 0;
	}

	/* A system message reads as a quiet marker like a compaction's, since it is
	   configuration rather than conversation; its text stays a click away. */
	.system-marker {
		color: var(--ap-fg-subtle);
		font-size: var(--ap-text-2xs);
		cursor: pointer;
		/* One line, whatever the change names: the disclosure holds the rest. */
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.system-body {
		display: flex;
		flex-direction: column;
		gap: var(--ap-space-3);
		margin-top: var(--ap-space-2);
		padding-left: var(--ap-space-3);
		border-left: 1px solid var(--ap-border);
		font-size: var(--ap-text-sm);
	}

	.system-label {
		margin: 0 0 var(--ap-space-1);
		font-size: var(--ap-text-2xs);
		font-weight: 600;
		color: var(--ap-fg-subtle);
	}

	/* Prompt text is tag-wrapped and line-structured, so it is shown as written
	   rather than through markdown, which would take the tags for HTML. */
	.system-text {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: inherit;
	}

	.system-removed {
		margin: 0;
		color: var(--ap-fg-subtle);
	}

	.system-body dl,
	.system-removed-tools {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: var(--ap-space-1);
	}

	.system-body dt {
		font-family: var(--ap-font-mono);
	}

	.system-body dd {
		margin: 0 0 0 var(--ap-space-3);
		white-space: pre-wrap;
	}

	.cursor {
		align-self: flex-start;
		color: var(--ap-fg-subtle);
		animation: ap-pulse 1.1s ease-in-out infinite;
	}

	@keyframes ap-pulse {
		0%,
		100% {
			opacity: 0.25;
		}
		50% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.cursor {
			animation: none;
		}
	}
</style>
