<script lang="ts">
	import { onMount, tick } from "svelte";
	import { sessionKey, type BackendId, type SessionSummary } from "$shared/protocol.ts";
	import type { AgentpaneController, ControllerView } from "./controller.ts";
	import Transcript from "./render/Transcript.svelte";
	import { previewMessages } from "./preview.ts";
	import { initialClientState } from "./session-state.ts";

	let { controller }: { controller: AgentpaneController } = $props();
	let view = $state<ControllerView>({
		state: initialClientState(),
		draft: "",
		connection: "connecting",
		busy: "idle",
		error: null,
		preview: null,
	});
	/**
	 * The workspace filter. A sentinel rather than "" so it can never collide
	 * with a real cwd (always an absolute path). `ALL` shows every session.
	 */
	const ALL_WORKSPACES = "__all__";
	let workspace = $state(ALL_WORKSPACES);
	let backend = $state<BackendId>("pi");
	/**
	 * Reading view (OW-51): elide the tool chrome so the prose can be read back
	 * while a session runs. One global boolean, deliberately not persisted and
	 * not per-session -- it resets on reload like the selects above.
	 */
	let reading = $state(false);
	let conversationEl: HTMLElement | undefined;
	// $state because it is bound inside a conditional block -- Svelte updates the
	// binding (element <-> undefined) as the composer swaps in and out.
	let promptEl = $state<HTMLTextAreaElement | undefined>();

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
	/**
	 * Which right-rail segments are inert (OW-60). The rail itself is always
	 * present -- it lives outside the scroller, so unlike the button it replaced
	 * it cannot scroll away from the reader -- and only its four segments come
	 * and go, by going disabled.
	 */
	let navDisabled = $state({ start: true, prev: true, next: true, end: true });
	/** Sub-pixel scroll positions are routine; treat this much as "already there". */
	const NAV_SLACK_PX = 4;
	/** 16x16 chevron glyphs for the rail, drawn as stroked polylines. */
	const NAV_ICONS = {
		start: ["M4 7.5 L8 3.5 L12 7.5", "M4 12.5 L8 8.5 L12 12.5"],
		prev: ["M4 10 L8 6 L12 10"],
		next: ["M4 6 L8 10 L12 6"],
		end: ["M4 3.5 L8 7.5 L12 3.5", "M4 8.5 L8 12.5 L12 8.5"],
	} as const;

	const selectedSession = $derived(
		view.state.selected === null ? undefined : view.state.sessions[sessionKey(view.state.selected)],
	);
	/** Most-recently-updated first -- the ordering cue the list otherwise has none of. */
	const sortedSummaries = $derived(
		[...view.state.summaries].sort((a, b) => recency(b) - recency(a)),
	);
	/** The distinct workspaces to offer, most-recently-used first (derived from the listed sessions). */
	const workspaceOptions = $derived.by(() => {
		const seen = new Set<string>();
		const options: string[] = [];
		for (const summary of sortedSummaries) {
			if (summary.cwd && !seen.has(summary.cwd)) {
				seen.add(summary.cwd);
				options.push(summary.cwd);
			}
		}
		return options;
	});
	/** The list narrowed to the chosen workspace -- client-side over the already-listed summaries. */
	const filteredSummaries = $derived(
		workspace === ALL_WORKSPACES ? sortedSummaries : sortedSummaries.filter((summary) => summary.cwd === workspace),
	);
	/** Whether the pane is showing a read-only preview rather than a live/attached transcript. */
	const previewing = $derived(view.preview !== null);
	/** The preview's text turns as messages, so the one Transcript renders both (OW-50). */
	const previewMessageList = $derived(
		view.preview ? previewMessages(view.preview.turns, view.preview.ref.backend) : [],
	);
	/** The summary for the currently selected session, for its workspace (New session inherits it). */
	const selectedSummary = $derived(
		view.state.selected === null
			? undefined
			: view.state.summaries.find((summary) => sessionKey(summary.ref) === sessionKey(view.state.selected!)),
	);
	const newSessionWorkspace = $derived(selectedSummary?.cwd ?? null);
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
		// Clamped to the scroller's *real* range, not just at zero, because the
		// no-op guard below is only sound if the assignment that follows it
		// actually moves. The browser clamps to that range regardless, so an
		// over-range value can pass the guard, change nothing, and fire no
		// `scroll` event -- stranding `suppressScrollHandling` armed for an event
		// that never comes, which then swallows the reader's next genuine scroll.
		// Measured in a real browser (OW-60): the session-switch effect below
		// runs `applyScrollTop(el, el.scrollHeight)`, which is always a full
		// clientHeight past the bottom, so attaching a session left the flag set;
		// a subsequent 4960px scroll fired its event and was discarded, and the
		// nav rail kept reporting the reader was still at the top.
		const clamped = Math.max(0, Math.min(value, el.scrollHeight - el.clientHeight));
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

	/**
	 * The user turns in document order -- the only candidates the rail steps
	 * between. Assistant and tool messages carry `data-role` too, and however
	 * many of them sit between two user turns they must not affect the step, so
	 * the selector names the role rather than walking siblings. `transcript.ts`
	 * preserves the original `data-index` even in reading view precisely so this
	 * stays true there.
	 */
	function userTurns(el: HTMLElement): HTMLElement[] {
		return Array.from(el.querySelectorAll<HTMLElement>('[data-role="user"]'));
	}

	/**
	 * The pivot is the first user turn at or below the viewport top; `prev` is the
	 * turn before it, `next` the turn after it. Deliberately not "the most
	 * visible turn": each jump parks its target's top edge on the viewport top,
	 * which makes that target the next pivot, so stepping from the pivot is what
	 * makes repeated clicks walk the transcript one user turn at a time in either
	 * direction. When every user turn is above the viewport top there is no
	 * pivot, and the last turn is the only place `prev` can go.
	 */
	function navTargets(el: HTMLElement): { prev: HTMLElement | null; next: HTMLElement | null } {
		const turns = userTurns(el);
		const pivot = turns.findIndex((turn) => anchorTop(el, turn) >= el.scrollTop - NAV_SLACK_PX);
		if (pivot === -1) return { prev: turns[turns.length - 1] ?? null, next: null };
		return { prev: turns[pivot - 1] ?? null, next: turns[pivot + 1] ?? null };
	}

	/**
	 * A direction is dead when the scroller is already hard against that end, or
	 * when there is no user turn to step to that way.
	 *
	 * The end conditions are not redundant for `prev`/`next`. The last screenful
	 * can hold user turns the scroller can never bring to its top, and there
	 * `next` would otherwise stay live while clicking it moved nothing: the jump
	 * clamps to the bottom, which is where it already was, so the pivot never
	 * advances. `prev` takes the mirror condition for symmetry, though at the top
	 * there is provably no earlier turn anyway.
	 *
	 * Must run from every path that moves the scroller or changes the transcript:
	 * `reconcile`, `handleConversationScroll`, and `navigate` itself.
	 */
	function updateNavState(el: HTMLElement): void {
		const atTop = el.scrollTop <= NAV_SLACK_PX;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NAV_SLACK_PX;
		const { prev, next } = navTargets(el);
		navDisabled = {
			start: atTop,
			prev: atTop || prev === null,
			next: atBottom || next === null,
			end: atBottom,
		};
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
		updateNavState(el);
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
		updateNavState(el);
	}

	/**
	 * The one mover behind all four rail segments. `start`/`end` are the true top
	 * and bottom of the scroller, not the first/last user turn. Every one of them
	 * is a manual reading action, so -- exactly like a manual scroll, and like the
	 * jump-to-latest button this rail replaces -- it disengages follow and never
	 * re-arms it. Only a fresh submit arms follow.
	 */
	function navigate(to: "start" | "prev" | "next" | "end"): void {
		const el = conversationEl;
		const ref = view.state.selected;
		if (!el || !ref) return;
		let target: number;
		if (to === "start") target = 0;
		else if (to === "end") target = el.scrollHeight - el.clientHeight;
		else {
			const node = navTargets(el)[to];
			if (!node) return;
			target = anchorTop(el, node);
		}
		const key = sessionKey(ref);
		const state = sessionScroll.get(key) ?? { top: 0, anchorIndex: null, hasStreamed: false };
		state.anchorIndex = null;
		applyScrollTop(el, target);
		// `applyScrollTop` suppresses the scroll handler, so this is the only
		// chance to keep the session's remembered position (restored on switch)
		// from going stale. Read back rather than reusing `target`: the browser
		// clamps to the real scroll range.
		state.top = el.scrollTop;
		sessionScroll.set(key, state);
		updateNavState(el);
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
			updateNavState(el);
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

	/**
	 * Auto-select the most recent session in scope -- on startup and whenever the
	 * workspace filter changes (OW-39). "In scope" = the top of the filtered,
	 * recency-sorted list. `controller.preview` keeps this cheap: it loads a
	 * read-only preview for a stored session and spawns nothing, or reselects a
	 * session this client is already attached to.
	 *
	 * The guard tracks the *ref* already auto-previewed, not just the workspace,
	 * and is written before the call: `controller.preview` publishes
	 * synchronously before it awaits, which re-invalidates this effect while
	 * `selected` is still null, so a guard that only clears on the async resolve
	 * never converges (OW-41 -- it threw `effect_update_depth_exceeded`).
	 */
	let autoWorkspace: string | null = null;
	let autoPreviewedKey: string | null = null;
	$effect(() => {
		const top = filteredSummaries[0];
		const topKey = top ? sessionKey(top.ref) : null;
		if (workspace !== autoWorkspace) {
			autoWorkspace = workspace;
			autoPreviewedKey = topKey;
			if (top) void controller.preview(top.ref);
		} else if (view.state.selected === null && top && autoPreviewedKey !== topKey) {
			// Startup: sessions arrived after the filter had already settled.
			autoPreviewedKey = topKey;
			void controller.preview(top.ref);
		}
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

	/** The final path segment of a cwd, which is always absolute (see ALL_WORKSPACES above). */
	function basename(cwd: string): string {
		return cwd.slice(cwd.lastIndexOf("/") + 1);
	}

	/**
	 * The sidebar row's label. `summary.preview` is server-supplied, parsed from
	 * the *first user message* of the stored JSONL -- which does not exist yet
	 * for a session whose first prompt has only just been sent, and nothing
	 * re-lists that session afterwards (only create/attach/rename/close emit
	 * `sessions-changed`), so it stays null until the next reload and the row
	 * shows the raw ref. Fall back to the same first-user-message text from the
	 * live view we already hold: this client *sent* that text, so it is certain
	 * whatever the file has, and it is the server's own preview semantics, so
	 * the eventual server value agrees rather than flickering to another string.
	 */
	function sessionLabel(summary: SessionSummary): string {
		return summary.preview || firstUserText(summary) || `${summary.ref.backend} ${summary.ref.id}`;
	}

	function firstUserText(summary: SessionSummary): string {
		for (const message of view.state.sessions[sessionKey(summary.ref)]?.messages ?? []) {
			if (message.role !== "user") continue;
			if (typeof message.content === "string") {
				if (message.content.trim()) return message.content.trim();
				continue;
			}
			const parts: string[] = [];
			for (const block of message.content) if (block.type === "text") parts.push(block.text);
			const text = parts.join(" ").trim();
			if (text) return text;
		}
		return "";
	}

	/** Keyed lookup rather than if/else so an unrecognised future backend id falls through to grey instead of silently matching a branch. */
	const backendColors: Partial<Record<BackendId, string>> = {
		codex: "var(--ap-success)",
		pi: "var(--ap-accent)",
	};
	function backendColor(id: BackendId): string {
		return backendColors[id] ?? "var(--ap-fg-subtle)";
	}

	/** New session inherits the selected session's workspace (OW-39); disabled when there is none. */
	function createSession(): void {
		if (!newSessionWorkspace) return;
		void controller.create(newSessionWorkspace, backend);
	}

	/** Promote a read-only preview into a live session via the existing attach path, then focus the prompt. */
	async function attachSelected(): Promise<void> {
		const ref = view.preview?.ref;
		if (!ref) return;
		await controller.select(ref);
		await tick();
		promptEl?.focus();
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

<!-- `aria-hidden` throughout: the rail's buttons are icon-only, so their whole
     accessible name is the `aria-label` on the button. -->
{#snippet navIcon(paths: readonly string[])}
	<svg class="rail-icon" viewBox="0 0 16 16" aria-hidden="true">
		{#each paths as d (d)}<path {d} />{/each}
	</svg>
{/snippet}

<main class="shell">
	<header class="masthead">
		<h1>agentpane</h1>
		<p role="status">{status}</p>
	</header>

	<section class="session-controls" aria-label="Session controls">
		<label>
			Workspace
			<select aria-label="Workspace" bind:value={workspace}>
				<option value={ALL_WORKSPACES}>All workspaces</option>
				{#each workspaceOptions as cwd (cwd)}
					<option value={cwd} title={cwd}>{basename(cwd)}</option>
				{/each}
			</select>
		</label>
		<div class="session-controls-row">
			<label>
				Backend
				<select aria-label="Backend" bind:value={backend}>
					<option value="pi">pi</option>
					<option value="codex">codex</option>
				</select>
			</label>
			<button type="button" onclick={createSession} disabled={!newSessionWorkspace}>New</button>
		</div>
		<!-- Stays visible, and inert, while previewing: a preview renders no tool
		     chrome to elide, and a control that appears and disappears on attach
		     is worse than one that is briefly a no-op. -->
		<button type="button" aria-pressed={reading} onclick={() => (reading = !reading)}>Reading view</button>
	</section>

	<nav class="sessions" aria-label="Sessions">
		{#each filteredSummaries as summary (sessionKey(summary.ref))}
			{@const label = sessionLabel(summary)}
			<button
				type="button"
				class="session-select"
				aria-pressed={view.state.selected !== null && sessionKey(view.state.selected) === sessionKey(summary.ref)}
				aria-label={label}
				onclick={() => void controller.preview(summary.ref)}
			>
				<span class="session-preview">{label}</span>
				<span class="session-meta">
					<span class="session-backend" style="color: {backendColor(summary.ref.backend)}">{summary.ref.backend}</span>
					{#if formatTimestamp(summary.updatedAt)}
						<time class="session-time" datetime={summary.updatedAt ?? undefined}>
							{formatTimestamp(summary.updatedAt)}
						</time>
					{/if}
					{#if summary.cwd}
						<span class="session-cwd" title={summary.cwd}>{basename(summary.cwd)}</span>
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
		{#if previewing}
			<!-- Read-only, non-attaching (OW-38/OW-39): text turns only, no streaming,
			     no tool/thinking chrome -- deliberately not a claim of live parity.
			     The empty case keeps its own wording rather than going through
			     Transcript: the server's text-only extraction can come up empty on a
			     session that has plenty in it, which "No messages yet" would misreport. -->
			{#if previewMessageList.length === 0}
				<p class="preview-empty">This session has no readable transcript to preview.</p>
			{:else}
				<Transcript messages={previewMessageList} />
			{/if}
		{:else}
			<Transcript
				messages={selectedSession?.messages ?? []}
				isStreaming={selectedSession?.isStreaming ?? false}
				{reading}
			/>
		{/if}
	</section>

	<!-- Outside `.conversation` on purpose (OW-60). Inside the scroller it would
	     scroll away with the very content it navigates, would sit over the
	     transcript, and would count toward the `scrollHeight` follow mode
	     measures. As a grid sibling it does none of the three. -->
	<nav class="rail" aria-label="Transcript navigation">
		<button type="button" aria-label="Jump to start" disabled={navDisabled.start} onclick={() => navigate("start")}>
			{@render navIcon(NAV_ICONS.start)}
		</button>
		<button type="button" aria-label="Previous user message" disabled={navDisabled.prev} onclick={() => navigate("prev")}>
			{@render navIcon(NAV_ICONS.prev)}
		</button>
		<button type="button" aria-label="Next user message" disabled={navDisabled.next} onclick={() => navigate("next")}>
			{@render navIcon(NAV_ICONS.next)}
		</button>
		<button type="button" aria-label="Jump to end" disabled={navDisabled.end} onclick={() => navigate("end")}>
			{@render navIcon(NAV_ICONS.end)}
		</button>
	</nav>

	{#if previewing}
		<div class="prompt attach">
			<button type="button" onclick={() => void attachSelected()}>Attach</button>
		</div>
	{:else}
		<form class="prompt" onsubmit={submitPrompt}>
			<textarea
				aria-label="Prompt"
				bind:this={promptEl}
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
	{/if}
</main>
