<script lang="ts">
	/**
	 * The transcript: a keyed list of messages, and the home of the design
	 * tokens for the whole render package.
	 *
	 * Tokens live here as `:global(:root)` custom properties rather than in a
	 * separate stylesheet so the package stays importable as pure Svelte --
	 * nothing to wire up in `main.ts` (which belongs to another workstream) and
	 * no CSS-import ambient declaration to add to the frozen tsconfig. If the
	 * shell later wants the palette without a transcript on screen, lift this
	 * block into `src/client/app.css` and import it once.
	 */
	import type { AgentMessage } from "@earendil-works/pi-agent-core";
	import Message from "./Message.svelte";
	import { buildTranscript } from "./transcript.ts";

	let {
		messages = [],
		isStreaming = false,
	}: { messages?: AgentMessage[]; isStreaming?: boolean } = $props();

	const view = $derived(buildTranscript(messages));
</script>

<div class="transcript" role="log" aria-busy={isStreaming}>
	{#each view.entries as entry (entry.key)}
		<Message
			message={entry.message}
			results={view.results}
			streaming={isStreaming && entry.index === view.lastIndex}
		/>
	{/each}

	{#if isStreaming && view.entries.length === 0}
		<p class="waiting">Waiting for the agent…</p>
	{/if}
	{#if !isStreaming && view.entries.length === 0}
		<p class="empty">No messages yet.</p>
	{/if}
</div>

<style>
	:global(:root) {
		/* -- type ------------------------------------------------------- */
		--ap-font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
			"Helvetica Neue", sans-serif;
		--ap-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
			"Liberation Mono", monospace;

		--ap-text-2xs: 0.6875rem;
		--ap-text-xs: 0.75rem;
		--ap-text-sm: 0.8125rem;
		--ap-text-md: 0.9375rem;
		--ap-text-lg: 1.0625rem;
		--ap-text-xl: 1.25rem;

		--ap-leading-tight: 1.3;
		--ap-leading-normal: 1.55;
		--ap-leading-relaxed: 1.7;

		/* -- space (4px base) ------------------------------------------- */
		--ap-space-1: 0.25rem;
		--ap-space-2: 0.5rem;
		--ap-space-3: 0.75rem;
		--ap-space-4: 1rem;
		--ap-space-5: 1.5rem;
		--ap-space-6: 2rem;
		--ap-space-7: 3rem;

		--ap-radius-sm: 4px;
		--ap-radius-md: 7px;
		--ap-radius-lg: 11px;

		/* -- semantic colour (light) ------------------------------------ */
		--ap-bg: #ffffff;
		--ap-bg-sunken: #f5f6f8;
		--ap-surface: #ffffff;
		--ap-surface-raised: #f1f3f6;
		--ap-border: #e2e5ea;
		--ap-border-strong: #c8cdd6;

		--ap-fg: #16191d;
		--ap-fg-muted: #59616d;
		--ap-fg-subtle: #8a929e;

		--ap-accent: #3959d9;
		--ap-accent-soft: #eaeeff;
		--ap-success: #157f4b;
		--ap-danger: #c22f3a;
		--ap-danger-soft: #fdecee;
		--ap-warning: #9a6700;

		--ap-add-bg: #e6f6ec;
		--ap-add-fg: #10693f;
		--ap-del-bg: #fdecee;
		--ap-del-fg: #a52734;

		/* -- syntax ------------------------------------------------------ */
		--ap-syn-keyword: #8b2fa0;
		--ap-syn-string: #0a7d55;
		--ap-syn-number: #a14a00;
		--ap-syn-comment: #8a929e;
		--ap-syn-function: #2b5fd0;
		--ap-syn-type: #9a6700;
		--ap-syn-attr: #b3462f;
	}

	@media (prefers-color-scheme: dark) {
		:global(:root) {
			--ap-bg: #15171b;
			--ap-bg-sunken: #101216;
			--ap-surface: #191c21;
			--ap-surface-raised: #21252c;
			--ap-border: #2a2f37;
			--ap-border-strong: #3b414b;

			--ap-fg: #e4e8ee;
			--ap-fg-muted: #9aa4b1;
			--ap-fg-subtle: #6c7683;

			--ap-accent: #7f9dff;
			--ap-accent-soft: #1d2436;
			--ap-success: #57c98a;
			--ap-danger: #f2707c;
			--ap-danger-soft: #2c1a1d;
			--ap-warning: #d8a33a;

			--ap-add-bg: #102a1c;
			--ap-add-fg: #63cf94;
			--ap-del-bg: #2c1a1d;
			--ap-del-fg: #f2707c;

			--ap-syn-keyword: #d08ce8;
			--ap-syn-string: #77d1a3;
			--ap-syn-number: #e5a26a;
			--ap-syn-comment: #6c7683;
			--ap-syn-function: #86a9ff;
			--ap-syn-type: #e0c07a;
			--ap-syn-attr: #f0937c;
		}
	}

	.transcript {
		display: flex;
		flex-direction: column;
		gap: var(--ap-space-5);
		padding: var(--ap-space-5) var(--ap-space-4);
		font-family: var(--ap-font-sans);
		font-size: var(--ap-text-md);
		line-height: var(--ap-leading-normal);
		color: var(--ap-fg);
		background: var(--ap-bg);
	}

	.waiting,
	.empty {
		margin: 0;
		color: var(--ap-fg-subtle);
		font-size: var(--ap-text-sm);
	}
</style>
