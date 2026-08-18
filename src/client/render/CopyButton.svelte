<script lang="ts">
	/**
	 * Copy one block's source to the clipboard (OW-63).
	 *
	 * What reaches the clipboard is the string the component that owns the block
	 * already holds -- never the rendered DOM. That is the whole reason the
	 * button beats drag-selection: it is precise (no tool name, status pill,
	 * streaming cursor or truncation notice comes along), it is the real bytes
	 * rather than the browser's whitespace reconstruction of the layout, and it
	 * is not limited to what is on screen (`Output.svelte` clips its display at
	 * `limit`; the copy is the whole thing).
	 *
	 * Feedback is inline and transient -- a ✓ or ✗ on the button itself, no
	 * global toast layer to own.
	 */

	type Feedback = "idle" | "copied" | "failed";

	let { source, label = "Copy" }: { source: string; label?: string } = $props();

	let feedback: Feedback = $state("idle");
	let timer: ReturnType<typeof setTimeout> | null = null;

	function flash(next: Feedback): void {
		feedback = next;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			feedback = "idle";
			timer = null;
		}, 1200);
	}

	/**
	 * `navigator.clipboard` is undefined in jsdom and on any non-secure origin,
	 * and `writeText` rejects when the document is not focused or permission is
	 * denied. All three are the same thing to the reader -- the copy did not
	 * happen -- so they land in one visible failure state rather than an
	 * exception nobody sees.
	 */
	async function copy(): Promise<void> {
		try {
			const clipboard = navigator.clipboard;
			if (!clipboard?.writeText) throw new Error("clipboard unavailable");
			await clipboard.writeText(source);
			flash("copied");
		} catch {
			flash("failed");
		}
	}

	$effect(() => () => {
		if (timer) clearTimeout(timer);
	});
</script>

<button
	class="ap-action"
	type="button"
	data-copy={feedback}
	title={label}
	aria-label={label}
	onclick={copy}
>
	{#if feedback === "copied"}✓{:else if feedback === "failed"}✗{:else}⧉{/if}
</button>
