<script lang="ts">
	import { onMount } from "svelte";
	import { sessionKey, type BackendId, type SessionSummary } from "$shared/protocol.ts";
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
	/** Most-recently-updated first -- the ordering cue the list otherwise has none of. */
	const sortedSummaries = $derived(
		[...view.state.summaries].sort((a, b) => recency(b) - recency(a)),
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

	function recency(summary: SessionSummary): number {
		const iso = summary.updatedAt ?? summary.createdAt;
		return iso ? Date.parse(iso) : 0;
	}

	/** UTC, so the label is deterministic regardless of the viewer's timezone. */
	function formatTimestamp(iso: string | null): string {
		if (!iso) return "";
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return "";
		return date.toISOString().slice(0, 16).replace("T", " ");
	}

	/** A short, stable label distinguishing two sessions that share a workspace and preview. */
	function shortId(id: string): string {
		return id.length > 8 ? id.slice(-8) : id;
	}

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
		{#each sortedSummaries as summary (sessionKey(summary.ref))}
			{@const label = summary.preview || `${summary.ref.backend} ${summary.ref.id}`}
			<div class="session-row">
				<button
					type="button"
					class="session-select"
					aria-pressed={view.state.selected !== null && sessionKey(view.state.selected) === sessionKey(summary.ref)}
					aria-label={label}
					onclick={() => void controller.select(summary.ref)}
				>
					<span class="session-preview">{label}</span>
					<span class="session-meta">
						<span class="session-backend">{summary.ref.backend}</span>
						<span class="session-id">{shortId(summary.ref.id)}</span>
						{#if formatTimestamp(summary.updatedAt ?? summary.createdAt)}
							<time class="session-time" datetime={summary.updatedAt ?? summary.createdAt ?? undefined}>
								{formatTimestamp(summary.updatedAt ?? summary.createdAt)}
							</time>
						{/if}
					</span>
				</button>
				{#if summary.status === "attached"}
					<button
						type="button"
						class="session-close"
						aria-label={`Close ${label}`}
						onclick={() => void controller.close(summary.ref)}
					>
						×
					</button>
				{/if}
			</div>
		{/each}
	</nav>

	{#if error}
		<p class="error" role="alert">
			<span>{error}</span>
			<button type="button" aria-label="Dismiss error" onclick={() => controller.clearError()}>Dismiss</button>
		</p>
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
