<script lang="ts">
	import type { TokenGate } from "./token.ts";

	/**
	 * Asks for the API token while `gate` is asking, which an API request
	 * answered 401 starts. `onStored` follows a paste, so the page recovers with
	 * nothing more from the owner. The field is a plain text field, so the owner
	 * sees what they pasted: they judged the prompt in use on 2026-11-13, found
	 * the dialog fine, and asked that the field not be a password box. It is
	 * still emptied on save, so a later 401 asks with an empty field and a
	 * stored token is never shown back.
	 */
	let { gate, onStored }: { gate: TokenGate; onStored: () => void } = $props();

	let asking = $state(false);
	let value = $state("");

	$effect(() => {
		asking = gate.asking();
		return gate.subscribe(() => {
			asking = gate.asking();
		});
	});

	function save(event: SubmitEvent): void {
		event.preventDefault();
		const token = value.trim();
		if (token === "") return;
		value = "";
		gate.store(token);
		onStored();
	}
</script>

{#if asking}
	<div class="token-backdrop">
		<div class="token-prompt" role="dialog" aria-modal="true" aria-labelledby="token-prompt-title">
			<h2 id="token-prompt-title">API token needed</h2>
			<p>
				The agentpane server refused this window's request. Paste the token from
				<code>~/.ssh/agentpane-token</code> on the server's machine.
			</p>
			<form onsubmit={save}>
				<input type="text" autocomplete="off" spellcheck="false" aria-label="API token" bind:value />
				<button type="submit">Save token</button>
			</form>
		</div>
	</div>
{/if}

<style>
	.token-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		background: rgb(0 0 0 / 0.4);
	}

	.token-prompt {
		display: grid;
		gap: 0.75rem;
		max-width: 28rem;
		padding: 1.25rem;
		border: 1px solid var(--ap-border-strong);
		border-radius: var(--ap-radius-lg);
		background: var(--ap-surface);
		color: var(--ap-fg);
		font-family: var(--ap-font-sans);
	}

	form {
		display: flex;
		gap: 0.5rem;
	}

	input {
		flex: 1;
	}

	h2 {
		margin: 0;
		font-size: var(--ap-text-lg);
	}

	p {
		margin: 0;
		font-size: var(--ap-text-sm);
		line-height: var(--ap-leading-normal);
	}
</style>
