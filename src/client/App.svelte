<script lang="ts">
	import { onMount } from "svelte";
	import { sessionKey, type BackendId } from "$shared/protocol.ts";
	import type { AgentpaneController, ControllerView } from "./controller.ts";
	import Transcript from "./render/Transcript.svelte";
	import { initialClientState } from "./session-state.ts";

	let { controller }: { controller: AgentpaneController } = $props();
	let view = $state<ControllerView>({
		state: initialClientState(),
		draft: "",
		connection: "connecting",
		busy: "idle",
		error: null,
	});
	let workspace = $state("");
	let backend = $state<BackendId>("pi");

	const selectedSession = $derived(
		view.state.selected === null ? undefined : view.state.sessions[sessionKey(view.state.selected)],
	);
	const error = $derived(view.error ?? selectedSession?.error ?? null);
	const status = $derived.by(() => {
		if (view.connection === "reconnecting") return "Reconnecting…";
		if (view.connection === "connecting") return "Connecting…";
		switch (view.busy) {
			case "listing":
				return "Loading sessions…";
			case "attaching":
				return "Opening session…";
			case "submitting":
				return "Sending prompt…";
			case "aborting":
				return "Aborting turn…";
			default:
				return "Connected";
		}
	});

	onMount(() => {
		view = controller.getView();
		const unsubscribe = controller.subscribe((next) => {
			view = next;
		});
		void controller.start();
		return () => {
			unsubscribe();
			controller.dispose();
		};
	});

	function selectWorkspace(): void {
		void controller.setWorkspace(workspace);
	}

	function createSession(): void {
		void controller.create(workspace, backend);
	}

	function submitPrompt(event: SubmitEvent): void {
		event.preventDefault();
		if (view.draft) void controller.submit();
	}

	/** Ctrl/Cmd-Enter submits; plain Enter inserts a newline (prompts are routinely multi-line). */
	function handlePromptKeydown(event: KeyboardEvent): void {
		if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
		event.preventDefault();
		if (view.draft) void controller.submit();
	}
</script>

<svelte:head>
	<title>agentpane</title>
</svelte:head>

<main class="shell">
	<header class="masthead">
		<h1>agentpane</h1>
		<p role="status">{status}</p>
	</header>

	<section class="session-controls" aria-label="Session controls">
		<label>
			Workspace
			<input aria-label="Workspace" bind:value={workspace} oninput={selectWorkspace} placeholder="/path/to/workspace" />
		</label>
		<label>
			Backend
			<select aria-label="Backend" bind:value={backend}>
				<option value="pi">pi</option>
				<option value="codex">codex</option>
			</select>
		</label>
		<button type="button" onclick={createSession}>New session</button>
	</section>

	<nav class="sessions" aria-label="Sessions">
		{#each view.state.summaries as summary (sessionKey(summary.ref))}
			<button
				type="button"
				aria-pressed={view.state.selected !== null && sessionKey(view.state.selected) === sessionKey(summary.ref)}
				onclick={() => void controller.select(summary.ref)}
			>
				{summary.preview || `${summary.ref.backend} ${summary.ref.id}`}
			</button>
		{/each}
	</nav>

	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}

	{#if selectedSession && selectedSession.requests.length > 0}
		<p class="warning">Unsupported agent request pending.</p>
	{/if}

	<section class="conversation" aria-label="Conversation">
		<Transcript messages={selectedSession?.messages ?? []} isStreaming={selectedSession?.isStreaming ?? false} />
	</section>

	<form class="prompt" onsubmit={submitPrompt}>
		<textarea
			aria-label="Prompt"
			value={view.draft}
			oninput={(event) => controller.setDraft(event.currentTarget.value)}
			onkeydown={handlePromptKeydown}
			placeholder="Ask the agent…"
		></textarea>
		<div class="prompt-actions">
			<button type="submit" disabled={!view.draft}>Send</button>
			{#if selectedSession?.isStreaming}
				<button type="button" class="abort" onclick={() => void controller.abort()}>Abort</button>
			{/if}
		</div>
	</form>
</main>
