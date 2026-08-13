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

	/**
	 * Per-session follow state (OW-27), keyed like everything else in the
	 * client state. `anchorIndex` is the message follow-mode is tracking --
	 * the one that was submitted -- or null when not following.
	 */
	interface SessionScroll {
		/** Last scrollTop, restored when switching back to a session that is not following. */
		top: number;
		anchorIndex: number | null;
		/**
		 * Whether `isStreaming` has read true at least once since `anchorIndex`
		 * was armed. `isStreaming` commonly still reads false on the upsert(s)
		 * that echo the submitted message and even the assistant's own
		 * placeholder back -- it is a separate SSE event, and D2 is explicit
		 * that cross-event ordering is not guaranteed -- so "not streaming" is
		 * only trustworthy as "the turn ended" once we know the turn actually
		 * started. Without this, the very first post-submit upsert(s) can
		 * disarm follow before the assistant's first token ever arrives.
		 */
		hasStreamed: boolean;
	}
	const sessionScroll = new Map<string, SessionScroll>();
	/**
	 * Session key -> `messages.length` right before a submit. Follow only
	 * engages once a message at or beyond that index actually exists: SSE
	 * ordering relative to the POST response is not guaranteed (D2), so this
	 * is re-checked against the live array on every update rather than
	 * assumed present the instant submit's promise resolves.
	 */
	const pendingFollow = new Map<string, number>();
	let lastScrollKey: string | null = null;
	let suppressScrollHandling = false;
	let followFrame: number | null = null;
	/** Shows whenever scrolled up from the true bottom, streaming or not. */
	let showJumpToLatest = $state(false);

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
		// Re-key the local follow/scroll maps synchronously, ahead of the state
		// publish above and thus ahead of the effects below that key off it --
		// otherwise a session's own rename (D9: every new session gets one, on
		// its first prompt) orphans its in-flight follow state under the old key.
		const unsubscribeRename = controller.onRename((from, to) => {
			const fromKey = sessionKey(from);
			const toKey = sessionKey(to);
			const scroll = sessionScroll.get(fromKey);
			if (scroll) {
				sessionScroll.delete(fromKey);
				sessionScroll.set(toKey, scroll);
			}
			const pending = pendingFollow.get(fromKey);
			if (pending !== undefined) {
				pendingFollow.delete(fromKey);
				pendingFollow.set(toKey, pending);
			}
			if (lastScrollKey === fromKey) lastScrollKey = toKey;
		});
		void controller.start();

		// Belt-and-suspenders for the effects below: Block.svelte throttles
		// re-parsing a streaming message's markdown to a frame (DESIGN D5), so
		// the transcript's real painted height can land a beat after the message
		// state that triggered it, and a state-driven check alone can
		// undershoot. A ResizeObserver on the transcript's own content is a
		// second trigger for the same reconciliation, regardless of what caused
		// the resize. jsdom has no ResizeObserver, so this is inert there.
		let observer: ResizeObserver | undefined;
		const content = conversationEl?.firstElementChild;
		if (content && typeof ResizeObserver !== "undefined") {
			observer = new ResizeObserver(() => reconcile());
			observer.observe(content);
		}

		return () => {
			unsubscribe();
			unsubscribeRename();
			controller.dispose();
			observer?.disconnect();
		};
	});

	// jsdom is configured with rAF, but do not make this depend on it -- same
	// fallback Markdown.svelte uses for its own throttle.
	function scheduleFrame(fn: () => void): number {
		return typeof requestAnimationFrame === "function"
			? requestAnimationFrame(fn)
			: (setTimeout(fn, 16) as unknown as number);
	}

	function unscheduleFrame(handle: number): void {
		if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
		else clearTimeout(handle);
	}

	function applyScrollTop(el: HTMLElement, value: number): void {
		const clamped = Math.max(0, value);
		// No-op guard matters here: assigning scrollTop fires a native `scroll`
		// event even when the value does not change, which would arm the
		// suppress flag for an event that may never come (or that arrives late
		// and swallows a genuine later user scroll).
		if (el.scrollTop === clamped) return;
		suppressScrollHandling = true;
		el.scrollTop = clamped;
	}

	/**
	 * How far down the scrollable content the anchor's own top edge sits.
	 * `getBoundingClientRect`, not `offsetTop`: neither `.conversation` nor
	 * `.transcript` establishes a positioned offsetParent, so `offsetTop` would
	 * be measured from `<body>`, not from the scroll container.
	 */
	function anchorTop(el: HTMLElement, anchorEl: HTMLElement): number {
		return anchorEl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
	}

	function updateJumpAffordance(el: HTMLElement): void {
		const SLACK_PX = 4;
		showJumpToLatest = el.scrollHeight - el.scrollTop - el.clientHeight > SLACK_PX;
	}

	/**
	 * The one place follow-mode actually moves the viewport. While anchored,
	 * keep the transcript scrolled to its true bottom -- except never far
	 * enough to push the anchor's own top edge above the container's top edge.
	 * That is the spec's "the message reaching the top of the viewport, where
	 * it locks": `Math.min` below is the cap, recomputed fresh every call, so
	 * once continuing would scroll the anchor off-screen the position simply
	 * stops advancing instead of chasing further growth below it.
	 */
	function reconcile(): void {
		const el = conversationEl;
		const ref = view.state.selected;
		if (!el || !ref) return;
		const state = sessionScroll.get(sessionKey(ref));
		if (state?.anchorIndex != null) {
			const anchorEl = el.querySelector<HTMLElement>(`[data-index="${state.anchorIndex}"]`);
			if (anchorEl) {
				const bottom = el.scrollHeight - el.clientHeight;
				applyScrollTop(el, Math.min(bottom, anchorTop(el, anchorEl)));
			}
		}
		updateJumpAffordance(el);
	}

	/** Same coalescing Block.svelte uses for its markdown throttle (D5): one pending frame while streaming, synchronous once settled. */
	function scheduleFollow(streaming: boolean): void {
		if (!streaming) {
			if (followFrame !== null) {
				unscheduleFrame(followFrame);
				followFrame = null;
			}
			reconcile();
			return;
		}
		if (followFrame === null) {
			followFrame = scheduleFrame(() => {
				followFrame = null;
				reconcile();
			});
		}
	}

	function handleConversationScroll(): void {
		if (suppressScrollHandling) {
			suppressScrollHandling = false;
			return;
		}
		const el = conversationEl;
		const ref = view.state.selected;
		if (!el || !ref) return;
		const key = sessionKey(ref);
		const state = sessionScroll.get(key) ?? { top: 0, anchorIndex: null, hasStreamed: false };
		state.top = el.scrollTop;
		state.anchorIndex = null; // a manual scroll always disengages follow
		sessionScroll.set(key, state);
		updateJumpAffordance(el);
	}

	/** Snaps once to the true bottom; never re-arms follow -- only a fresh submit does that. */
	function jumpToLatest(): void {
		const el = conversationEl;
		const ref = view.state.selected;
		if (!el || !ref) return;
		const key = sessionKey(ref);
		const state = sessionScroll.get(key) ?? { top: 0, anchorIndex: null, hasStreamed: false };
		state.anchorIndex = null;
		sessionScroll.set(key, state);
		applyScrollTop(el, el.scrollHeight - el.clientHeight);
		updateJumpAffordance(el);
	}

	/** On submit, arm follow-mode for whatever message this submission produces. */
	function armFollow(): void {
		const ref = view.state.selected;
		if (!ref) return;
		pendingFollow.set(sessionKey(ref), selectedSession?.messages.length ?? 0);
	}

	/**
	 * Switching sessions restores that session's own scroll position -- or, if
	 * it is mid-follow (submitted, then switched away before the turn ended),
	 * re-anchors immediately against the freshly rendered DOM. A session never
	 * opened yet has no memory, so it defaults to the bottom.
	 */
	$effect(() => {
		const ref = view.state.selected;
		const key = ref ? sessionKey(ref) : null;
		if (key === lastScrollKey) return;
		lastScrollKey = key;

		const el = conversationEl;
		if (!el) return;
		const state = key ? sessionScroll.get(key) : undefined;
		if (state?.anchorIndex != null) {
			reconcile();
		} else {
			applyScrollTop(el, state ? state.top : el.scrollHeight);
			updateJumpAffordance(el);
		}
	});

	/**
	 * Message-boundary upserts and turn-status flips drive follow mode:
	 * arming a pending follow (from `armFollow`) once its message exists, and
	 * disengaging when the turn ends (nothing left to chase). The actual
	 * scroll adjustment is `reconcile`, via the same throttle as the markdown
	 * re-render (D5).
	 */
	$effect(() => {
		const ref = view.state.selected;
		const key = ref ? sessionKey(ref) : null;
		const messages = selectedSession?.messages;
		const streaming = selectedSession?.isStreaming ?? false;
		if (!key || !messages || key !== lastScrollKey) return;

		// `isStreaming` commonly still reads false on the upsert(s) that echo
		// the submitted message, and even the assistant's own placeholder,
		// back -- it is a separate SSE event and D2 is explicit that
		// cross-event ordering is not guaranteed. So "not streaming" only means
		// "the turn ended" once we know the turn actually *started* -- tracked
		// per-anchor via `hasStreamed`, set the first time this session reads
		// isStreaming:true while armed. Without that distinction, an early
		// false reading disarms follow before the assistant ever gets going.
		// Caught live (OW-27): a synthetic submit, followed by upserts for both
		// the echoed user message and the assistant's opening content, with the
		// matching status:true event arriving only after both, reproduced
		// exactly this.
		const existing = sessionScroll.get(key);
		if (existing?.anchorIndex != null) {
			if (streaming) existing.hasStreamed = true;
			else if (existing.hasStreamed) existing.anchorIndex = null;
		}

		const pendingFrom = pendingFollow.get(key);
		if (pendingFrom !== undefined) {
			for (let i = messages.length - 1; i >= pendingFrom; i--) {
				if (messages[i]?.role === "user") {
					const state = sessionScroll.get(key) ?? { top: 0, anchorIndex: null, hasStreamed: false };
					state.anchorIndex = i;
					state.hasStreamed = streaming;
					sessionScroll.set(key, state);
					pendingFollow.delete(key);
					break;
				}
			}
		}

		scheduleFollow(streaming);
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

	function selectWorkspace(): void {
		void controller.setWorkspace(workspace);
	}

	function createSession(): void {
		void controller.create(workspace, backend);
	}

	function submitPrompt(event: SubmitEvent): void {
		event.preventDefault();
		if (!view.draft) return;
		armFollow();
		void controller.submit();
	}

	/** Ctrl/Cmd-Enter submits; plain Enter inserts a newline (prompts are routinely multi-line). */
	function handlePromptKeydown(event: KeyboardEvent): void {
		if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
		event.preventDefault();
		if (!view.draft) return;
		armFollow();
		void controller.submit();
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
		{#if showJumpToLatest}
			<button type="button" class="jump-to-latest" onclick={jumpToLatest}>Jump to latest ↓</button>
		{/if}
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
