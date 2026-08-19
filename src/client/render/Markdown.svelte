<script lang="ts">
	/**
	 * A markdown text block.
	 *
	 * The known hot spot (D5) is re-parsing markdown on every token of a long
	 * streaming message. Two things keep that cheap:
	 *
	 * - **Only the tail block re-parses.** Each text block is its own instance
	 *   of this component, and an unchanged block's `text` prop reads `===`, so
	 *   the effect below is not re-run and earlier blocks are untouched. That
	 *   rests on `App.svelte`'s `view` being `$state.raw` (OW-detepa), not on
	 *   the component boundary: `text={block.text}` in `Block.svelte` creates no
	 *   derived boundary, so this effect subscribes straight to the `{#each}`
	 *   item source and a deep proxy's reassignment marked it *dirty*, not
	 *   maybe-dirty -- and effects, unlike deriveds, do not value-compare.
	 * - **Throttled to a frame.** While `streaming`, updates coalesce into one
	 *   `requestAnimationFrame`; deltas that land inside the same frame are
	 *   collapsed. The initial parse and the final one (when `streaming` goes
	 *   false) are synchronous, so a settled transcript is never a frame behind
	 *   and tests do not have to await one.
	 */
	import BlockActions from "./BlockActions.svelte";
	import { renderMarkdownWithFences } from "./markdown.ts";

	let {
		text = "",
		streaming = false,
		/** Per-fence copy/expand controls. Off inside the expand overlay, which is already showing one block. */
		fenceActions = true,
	}: { text?: string; streaming?: boolean; fenceActions?: boolean } = $props();

	// Both of these capture `text`'s *initial* value on purpose: the effect
	// below owns every subsequent update, and seeding synchronously is what
	// makes a settled transcript paint in one pass.
	// svelte-ignore state_referenced_locally
	let rendered = $state(renderMarkdownWithFences(text));
	// svelte-ignore state_referenced_locally
	let latest = text;
	let frame: number | null = null;

	// jsdom is configured with rAF, but do not make the renderer depend on it.
	function schedule(fn: () => void): number {
		return typeof requestAnimationFrame === "function"
			? requestAnimationFrame(fn)
			: (setTimeout(fn, 16) as unknown as number);
	}

	function unschedule(handle: number): void {
		if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
		else clearTimeout(handle);
	}

	$effect(() => {
		latest = text;
		const live = streaming;

		if (!live) {
			if (frame !== null) {
				unschedule(frame);
				frame = null;
			}
			rendered = renderMarkdownWithFences(latest);
			return;
		}

		if (frame === null) {
			frame = schedule(() => {
				frame = null;
				rendered = renderMarkdownWithFences(latest);
			});
		}
	});

	$effect(() => () => {
		if (frame !== null) unschedule(frame);
	});

	/**
	 * Fence controls (OW-63). A fenced code block is one of the units the
	 * reader copies, but there is no component for it: it reaches the DOM as
	 * part of this one `{@html}` string, and `sanitize()` forbids `<button>`,
	 * so the control cannot be emitted inside that string -- nor should it be,
	 * since that is exactly the choke point D5 exists to keep narrow.
	 *
	 * So the controls are ours, rendered by Svelte below with real listeners
	 * and no `{@html}` anywhere near them, and this effect only *moves* each
	 * one next to the `<pre>` it belongs to, matched by the `data-fence` index
	 * the code renderer wrote.
	 *
	 * A re-parse replaces the `<pre>` a control was moved next to, but not the
	 * control: `{@html}` removes only the nodes it inserted, so a node we moved
	 * in survives and the new `<pre>` lands in front of it (verified in jsdom --
	 * the element identity changes, the adjacency does not). What the `rendered`
	 * dependency actually buys is a change in the *number* of fences: a fence
	 * that first appears in a later streaming frame has no control beside it
	 * until this effect runs again.
	 */
	let host: HTMLElement | undefined = $state();
	let controls: (HTMLElement | undefined)[] = $state([]);

	$effect(() => {
		void rendered;
		if (!host) return;
		for (const pre of host.querySelectorAll("pre.ap-code[data-fence]")) {
			const node = controls[Number(pre.getAttribute("data-fence"))];
			if (node) pre.insertAdjacentElement("afterend", node);
		}
	});
</script>

<!-- Safe by construction: `renderMarkdownWithFences` is the only producer of
     this string and it ends in DOMPurify. See markdown.ts. -->
<div class="markdown" bind:this={host}>{@html rendered.html}</div>

<!-- Unattached controls stay in here and stay hidden; the effect above lifts
     each one out to the fence it belongs to. -->
{#if fenceActions}
	<div class="fence-dock" hidden>
		{#each rendered.fences as fence, i (i)}
			<div class="fence-actions" bind:this={controls[i]}>
				<BlockActions source={fence.code} kind="code" language={fence.language} label="code block" />
			</div>
		{/each}
	</div>
{/if}

<style>
	.markdown {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.markdown :global(> :first-child) {
		margin-top: 0;
	}
	.markdown :global(> :last-child) {
		margin-bottom: 0;
	}

	.markdown :global(p),
	.markdown :global(ul),
	.markdown :global(ol),
	.markdown :global(blockquote),
	.markdown :global(table) {
		margin: 0 0 var(--ap-space-3);
	}

	.markdown :global(h1),
	.markdown :global(h2),
	.markdown :global(h3),
	.markdown :global(h4),
	.markdown :global(h5),
	.markdown :global(h6) {
		margin: var(--ap-space-4) 0 var(--ap-space-2);
		line-height: var(--ap-leading-tight);
		font-weight: 600;
	}
	.markdown :global(h1) {
		font-size: var(--ap-text-xl);
	}
	.markdown :global(h2) {
		font-size: var(--ap-text-lg);
	}
	.markdown :global(h3),
	.markdown :global(h4),
	.markdown :global(h5),
	.markdown :global(h6) {
		font-size: var(--ap-text-md);
	}

	.markdown :global(ul),
	.markdown :global(ol) {
		padding-left: var(--ap-space-5);
	}
	.markdown :global(li) {
		margin: var(--ap-space-1) 0;
	}

	.markdown :global(a) {
		color: var(--ap-accent);
		text-underline-offset: 2px;
	}

	/* A file reference is not a link and must not look like one: monospace and
	   muted, marked as a location by a dotted rule rather than by accent
	   colour. First cut -- the verdict comes from looking at it (OW-62). */
	.markdown :global(.ap-file-ref) {
		font-family: var(--ap-font-mono);
		font-size: 0.9em;
		color: var(--ap-fg-muted);
		border-bottom: 1px dotted var(--ap-border-strong);
	}

	.markdown :global(blockquote) {
		padding-left: var(--ap-space-3);
		border-left: 2px solid var(--ap-border-strong);
		color: var(--ap-fg-muted);
	}

	.markdown :global(hr) {
		height: 1px;
		margin: var(--ap-space-4) 0;
		border: 0;
		background: var(--ap-border);
	}

	.markdown :global(code) {
		font-family: var(--ap-font-mono);
		font-size: 0.9em;
	}

	/* Inline code only -- the fenced renderer emits `pre.ap-code > code`. */
	.markdown :global(:not(pre) > code) {
		padding: 0.1em 0.35em;
		border-radius: var(--ap-radius-sm);
		background: var(--ap-surface-raised);
		border: 1px solid var(--ap-border);
	}

	.markdown :global(pre.ap-code) {
		margin: 0 0 var(--ap-space-3);
		padding: var(--ap-space-3);
		border-radius: var(--ap-radius-md);
		background: var(--ap-bg-sunken);
		border: 1px solid var(--ap-border);
		/* Wide content scrolls inside its own box; the page never scrolls sideways. */
		overflow-x: auto;
		line-height: var(--ap-leading-normal);
	}

	/* Lifted out of the dock and dropped in after its `<pre>`, so it sits in the
	   gap that block's margin already leaves. */
	.fence-actions {
		margin: calc(-1 * var(--ap-space-2)) 0 var(--ap-space-3);
	}

	.markdown :global(table) {
		border-collapse: collapse;
		display: block;
		overflow-x: auto;
		font-size: var(--ap-text-sm);
	}
	.markdown :global(th),
	.markdown :global(td) {
		padding: var(--ap-space-1) var(--ap-space-3);
		border: 1px solid var(--ap-border);
		text-align: left;
	}
	.markdown :global(th) {
		background: var(--ap-surface-raised);
	}

	.markdown :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: var(--ap-radius-md);
	}

	/* highlight.js token classes, mapped onto our own palette rather than
	   importing one of its stylesheets -- that keeps light/dark on the same
	   tokens as the rest of the UI. */
	.markdown :global(.hljs-keyword),
	.markdown :global(.hljs-selector-tag),
	.markdown :global(.hljs-literal),
	.markdown :global(.hljs-built_in) {
		color: var(--ap-syn-keyword);
	}
	.markdown :global(.hljs-string),
	.markdown :global(.hljs-regexp),
	.markdown :global(.hljs-addition) {
		color: var(--ap-syn-string);
	}
	.markdown :global(.hljs-number),
	.markdown :global(.hljs-symbol) {
		color: var(--ap-syn-number);
	}
	.markdown :global(.hljs-comment),
	.markdown :global(.hljs-quote) {
		color: var(--ap-syn-comment);
		font-style: italic;
	}
	.markdown :global(.hljs-title),
	.markdown :global(.hljs-function .hljs-title),
	.markdown :global(.hljs-section) {
		color: var(--ap-syn-function);
	}
	.markdown :global(.hljs-type),
	.markdown :global(.hljs-class .hljs-title),
	.markdown :global(.hljs-params) {
		color: var(--ap-syn-type);
	}
	.markdown :global(.hljs-attr),
	.markdown :global(.hljs-attribute),
	.markdown :global(.hljs-variable),
	.markdown :global(.hljs-template-variable),
	.markdown :global(.hljs-meta) {
		color: var(--ap-syn-attr);
	}
	.markdown :global(.hljs-deletion) {
		color: var(--ap-del-fg);
	}
	.markdown :global(.hljs-emphasis) {
		font-style: italic;
	}
	.markdown :global(.hljs-strong) {
		font-weight: 600;
	}
</style>
