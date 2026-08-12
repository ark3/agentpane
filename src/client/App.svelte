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
	let conversationEl: HTMLElement | undefined;
	/** Per-session scroll memory (OW-27): keyed like everything else in the client state. */
	const scrollMemory = new Map<string, { top: number; pinned: boolean }>();
	let lastScrollKey: string | null = null;

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

		// Belt-and-suspenders for the scroll effect below: Block.svelte throttles
		// re-parsing a streaming message's markdown to a frame (DESIGN D5), so the
		// transcript's real painted height can land a beat after the message
		// state that triggered it. A ResizeObserver on the transcript's own
		// content catches that late paint too, regardless of what caused it.
		// jsdom has no ResizeObserver, so this is inert (and untested) there --
		// the effect below covers the state-driven case jsdom can pin.
		let observer: ResizeObserver | undefined;
		const el = conversationEl;
		const content = el?.firstElementChild;
		if (el && content && typeof ResizeObserver !== "undefined") {
			observer = new ResizeObserver(() => {
				const ref = view.state.selected;
				const key = ref ? sessionKey(ref) : null;
				const anchor = key ? scrollMemory.get(key) : undefined;
				if (!anchor || anchor.pinned) el.scrollTop = el.scrollHeight;
			});
			observer.observe(content);
		}

		return () => {
			unsubscribe();
			controller.dispose();
			observer?.disconnect();
		};
	});

	const NEAR_BOTTOM_PX = 48;

	function isNearBottom(el: HTMLElement): boolean {
		return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
	}

	/** Records where the user left off, and whether they were following the tail. */
	function handleConversationScroll(): void {
		const el = conversationEl;
		const ref = view.state.selected;
		if (!el || !ref) return;
		scrollMemory.set(sessionKey(ref), { top: el.scrollTop, pinned: isNearBottom(el) });
	}

	/**
	 * Switching sessions restores that session's own scroll position (or the
	 * tail, for one with no memory yet). Staying on the same session, new
	 * content arriving (a message-boundary upsert or a status flip) only pulls
	 * the view down if the user was already at the bottom.
	 *
	 * The "was at the bottom" answer comes from `scrollMemory`'s `pinned` flag
	 * -- set only when the user actually scrolls -- not from re-deriving
	 * proximity against the *current* scrollHeight each time this runs. A
	 * single large upsert (or the update that first makes the transcript
	 * overflow, when scrollTop has necessarily been 0) can move scrollHeight by
	 * more than the near-bottom threshold in one step; comparing a still-stale
	 * scrollTop to the new scrollHeight would then read as "not near the
	 * bottom" even though the user never scrolled, silently ending autoscroll
	 * for the rest of the turn. Caught live (OW-27): a synthetic stream with
	 * multi-paragraph deltas reproduced exactly this.
	 */
	$effect(() => {
		const ref = view.state.selected;
		const key = ref ? sessionKey(ref) : null;
		// Re-run on new transcript content, not just on selection changes.
		void selectedSession?.messages;
		void selectedSession?.isStreaming;

		const el = conversationEl;
		if (!el) return;
		const anchor = key ? scrollMemory.get(key) : undefined;

		if (key !== lastScrollKey) {
			lastScrollKey = key;
			el.scrollTop = anchor && !anchor.pinned ? anchor.top : el.scrollHeight;
			return;
		}

		if (!anchor || anchor.pinned) el.scrollTop = el.scrollHeight;
	});

	function recency(summary: SessionSummary): number {
		const iso = summary.updatedAt ?? summary.createdAt;
		return iso ? Date.parse(iso) : 0;
	}

	/** ISO to the second, UTC so it is deterministic regardless of the viewer's timezone. */
	function formatTimestamp(iso: string | null): string {
		if (!iso) return "";
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return "";
		return date.toISOString().slice(0, 19).replace("T", " ");
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
					{#if summary.cwd}
						<span class="session-cwd">{summary.cwd}</span>
					{/if}
					{#if formatTimestamp(summary.updatedAt)}
						<time class="session-time" datetime={summary.updatedAt ?? undefined}>
							{formatTimestamp(summary.updatedAt)}
						</time>
					{/if}
					{#if summary.isStreaming}
						<span class="session-streaming" aria-label="Streaming">●</span>
					{/if}
				</span>
			</button>
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

	<section class="conversation" aria-label="Conversation" bind:this={conversationEl} onscroll={handleConversationScroll}>
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
