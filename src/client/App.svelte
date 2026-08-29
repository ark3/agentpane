<script lang="ts">
	import { onMount, tick } from "svelte";
	import { sessionKey, type BackendId, type SessionSummary } from "$shared/protocol.ts";
	import type { AgentpaneController, ControllerView } from "./controller.ts";
	import {
		emptyTurnWatch,
		setFaviconBadge,
		watchFocus,
		watchRename,
		watchSessions,
		watchSubmit,
	} from "./favicon.ts";
	import Transcript from "./render/Transcript.svelte";
	import { userBlocks } from "./render/types.ts";
	import { previewMessages } from "./preview.ts";
	import { initialClientState } from "./session-state.ts";
	import { formatTimestamp, recency } from "./time.ts";

	let { controller }: { controller: AgentpaneController } = $props();
	/**
	 * `$state.raw`, and that is load-bearing rather than a micro-optimisation
	 * (OW-detepa). A deep `$state` proxies the whole view, and `publish()`
	 * swaps a fresh `ControllerView` per SSE event, so every settled markdown
	 * block in the selected transcript re-parsed on every event -- including
	 * events for sessions that are not on screen, at ~92ms each on a 180-message
	 * transcript. Raw keeps object identity for the parts that did not change,
	 * and the derived equality check stops propagation at the top.
	 *
	 * It stops working silently the moment anything mutates `view` in place:
	 * nothing enforces that, so assign a new object, as `controller.publish`
	 * does. `App.streaming-cost.test.ts` counts the parses.
	 */
	let view = $state.raw<ControllerView>({
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
	/**
	 * The earlier user message the composer is editing (OW-hezidi), or null.
	 *
	 * Nothing here has touched the server: clicking edit fills the composer and
	 * marks the transcript, and that is all, so the click is free and
	 * abandonable. The fork happens at submit. `stashedDraft` is whatever the
	 * composer held when the edit displaced it, put back by Cancel.
	 *
	 * `ordinal` is the message's position *among user messages*, which is how
	 * the fork point is addressed: `GET fork-points` answers one point per user
	 * message in transcript order on every backend, while `PaneMessage` carries
	 * no id of its own (D11 freezes `protocol.ts`, so it cannot grow one).
	 * Matching on wording instead would break on two identical messages.
	 */
	let editing = $state<{
		index: number;
		ordinal: number;
		images: { mimeType: string; base64: string }[];
		stashedDraft: string;
	} | null>(null);
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
		/** Scroll height from the last follow reconciliation. */
		height: number;
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
	/**
	 * Which sessions this tab has a turn outstanding on, and whether one of
	 * them has finished unnoticed (OW-diyuwu). A plain `let`, not `$state`: the
	 * effect below both reads and writes it, and the only thing that ever
	 * renders from it is the favicon, which is not part of this component.
	 */
	let turnWatch = emptyTurnWatch();
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
	/**
	 * Most-recently-updated first -- the ordering cue the list otherwise has none of.
	 *
	 * The extra derived is the point (OW-jineli): it makes the sort depend on the
	 * *array* rather than on `view`, and nothing in an `upsert` touches
	 * `summaries`, so a streaming token recomputes `summaries` to the identical
	 * reference and stops there rather than re-sorting the whole corpus. It works
	 * only while `view` is `$state.raw` (the docblock at the top of this file):
	 * under a deep proxy the array reference changes on every publish and this
	 * buys nothing.
	 */
	const summaries = $derived(view.state.summaries);
	const sortedSummaries = $derived([...summaries].sort((a, b) => recency(b) - recency(a)));
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
	/** The preview's store timestamps converted for the one Transcript both paths share. */
	const previewMessageList = $derived(
		view.preview ? previewMessages(view.preview.turns) : [],
	);
	/** The summary for the currently selected session, for its workspace (New session inherits it). */
	const selectedSummary = $derived(
		view.state.selected === null
			? undefined
			: view.state.summaries.find((summary) => sessionKey(summary.ref) === sessionKey(view.state.selected!)),
	);
	const newSessionWorkspace = $derived(selectedSummary?.cwd ?? null);
	const error = $derived(view.error ?? selectedSession?.error ?? null);
	const streamingNow = $derived(selectedSession?.isStreaming ?? false);
	/**
	 * The primary button names every consequence it will have (OW-hezidi).
	 * "Fork", not a plainer phrase: all three CLIs in play use that word for this
	 * operation and for the new-session sense of it. Never "rewind" -- that is
	 * Claude Code's word for the in-place operation, which agentpane does not
	 * offer and Codex cannot do at all.
	 */
	const sendLabel = $derived(editing ? (streamingNow ? "Stop and fork" : "Fork") : "Send");
	/**
	 * The last user message in the selected transcript, or null if there is none
	 * to go back to (OW-relehi). The composer's shortcut renders only when this
	 * is an index, matching how Stop behaves in that row: absent, not disabled.
	 */
	const lastUserIndex = $derived.by(() => {
		const messages = selectedSession?.messages ?? [];
		for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return i;
		return null;
	});
	/** Advisory only (OW-73): a leading `/` is the whole trigger, deliberately imprecise -- Send still works either way. */
	const looksLikeSlashCommand = $derived(view.draft.startsWith("/"));
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
			case "compacting":
				return "Compacting context…";
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
		const unsubscribeRename = controller.onRename((from, to) =>
			rekeySession(sessionKey(from), sessionKey(to)),
		);
		void controller.start();

		// A read-only preview polls itself, but the controller owns no DOM (OW-76),
		// so the tab's comings and goings are heard here and forwarded. `focus` as
		// well as `visibilitychange` because switching windows on one desktop never
		// hides the document. Going *out* matters as much as coming back: the
		// controller reads the injected predicate and stops its timer.
		const onTabVisibility = () => void controller.refreshPreview();
		document.addEventListener("visibilitychange", onTabVisibility);
		window.addEventListener("focus", onTabVisibility);

		// The badge clears the moment the window is focused (OW-diyuwu). Its own
		// listener rather than a branch inside the one above: the two features
		// share an event and nothing else, and this one has no business firing on
		// `visibilitychange`, which moves without focus moving.
		const onWindowFocus = () => {
			turnWatch = watchFocus(turnWatch);
			setFaviconBadge(turnWatch.badged);
		};
		window.addEventListener("focus", onWindowFocus);

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
			document.removeEventListener("visibilitychange", onTabVisibility);
			window.removeEventListener("focus", onTabVisibility);
			window.removeEventListener("focus", onWindowFocus);
			controller.dispose();
			observer?.disconnect();
		};
	});

	/**
	 * Move this tab's own per-session state -- follow, remembered scroll, the
	 * badge's turn watch -- from one session key to another.
	 *
	 * Two things move a session's key under an in-flight turn. A `renamed` event
	 * (D9: every new session gets one on its first prompt), and a fork, where
	 * Pi renames but Codex answers with a brand-new ref it renames nothing to
	 * (OW-hezidi). Orphaning this state under the old key strands follow mode
	 * mid-turn, which is what OW-27 was.
	 */
	function rekeySession(fromKey: string, toKey: string): void {
		if (fromKey === toKey) return;
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
		turnWatch = watchRename(turnWatch, fromKey, toKey);
	}

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
				// Remember the position we selected, so a later height *shrink*
				// can be distinguished from the reader scrolling by hand below.
				state.top = el.scrollTop;
				state.height = el.scrollHeight;
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
		const state = sessionScroll.get(key) ?? {
			top: 0,
			height: el.scrollHeight,
			anchorIndex: null,
			hasStreamed: false,
		};
		const bottom = el.scrollHeight - el.clientHeight;
		// A transcript can shrink while the stream is live: thinking collapses
		// around a tool call, and Reading view elides that same chrome. Chromium
		// clamps a too-large scrollTop to the new bottom and fires `scroll` for
		// it. That is not a manual reading action, so keep following; later
		// streamed content will grow the pane back past the saved landmark.
		if (
			state.anchorIndex !== null &&
			el.scrollHeight < state.height &&
			state.top > bottom &&
			el.scrollTop === bottom
		) {
			state.top = el.scrollTop;
			state.height = el.scrollHeight;
			sessionScroll.set(key, state);
			updateNavState(el);
			return;
		}
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
		const state = sessionScroll.get(key) ?? {
			top: 0,
			height: el.scrollHeight,
			anchorIndex: null,
			hasStreamed: false,
		};
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

	/**
	 * On submit, arm follow-mode for whatever message this submission produces.
	 *
	 * `from` is the index the produced message cannot land before. It defaults to
	 * the transcript's current length, which is right for an ordinary prompt; a
	 * fork's transcript is the parent truncated just before the edited message,
	 * so there the caller passes that message's index instead -- the parent's
	 * length would sit past the end of the fork and never arm (OW-hezidi).
	 */
	function armFollow(from?: number): void {
		const ref = view.state.selected;
		if (!ref) return;
		pendingFollow.set(sessionKey(ref), from ?? selectedSession?.messages.length ?? 0);
	}

	/**
	 * On submit, start waiting for this turn to end (OW-diyuwu). Here rather
	 * than inside the controller, which owns no DOM and no window focus, and
	 * beside `armFollow` because these two call sites are the app's only submit
	 * path: a session that streams without passing through them is one this tab
	 * did not ask for and must not be badged for.
	 */
	function armBadge(): void {
		const ref = view.state.selected;
		if (!ref) return;
		turnWatch = watchSubmit(turnWatch, sessionKey(ref));
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
		// An edit is anchored to one transcript by index, so it cannot survive the
		// pane moving to another one: the mark would land on an unrelated message
		// and the ordinal would address the wrong session's fork points. The
		// displaced draft is not restored here -- switching sessions has never
		// rewritten the composer, and this is a switch.
		editing = null;

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
					const state = sessionScroll.get(key) ?? {
						top: 0,
						height: conversationEl?.scrollHeight ?? 0,
						anchorIndex: null,
						hasStreamed: false,
					};
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
	 * The turn-done favicon badge (OW-diyuwu). Every session, not just the
	 * selected one: you submit, switch away to read something else, and the
	 * turn you are waiting for is the one you are no longer looking at.
	 *
	 * `document.hasFocus()` is read here, at the moment the turn ends, rather
	 * than tracked through `focus`/`blur` events -- one read of the live answer
	 * cannot drift out of step with the window the way a mirrored flag can.
	 */
	$effect(() => {
		const streaming = new Map<string, boolean>();
		for (const [key, session] of Object.entries(view.state.sessions)) {
			streaming.set(key, session.isStreaming);
		}
		turnWatch = watchSessions(turnWatch, streaming, document.hasFocus());
		setFaviconBadge(turnWatch.badged);
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
		codex: "var(--ap-backend-codex)",
		claude: "var(--ap-backend-claude)",
		pi: "var(--ap-backend-pi)",
	};
	function backendColor(id: BackendId): string {
		return backendColors[id] ?? "var(--ap-fg-subtle)";
	}

	/** New session inherits the selected session's workspace (OW-39); disabled when there is none. */
	function createSession(): void {
		if (!newSessionWorkspace) return;
		void controller.create(newSessionWorkspace, backend);
	}

	/**
	 * "Another conversation like this one" (OW-72): inherit the selected
	 * session's workspace AND backend, unlike the configured New button which
	 * reads the two selects. Disabled with nothing selected -- there is nothing
	 * to inherit -- so this guard is the whole of that case.
	 */
	function newConversation(): void {
		const ref = view.state.selected;
		if (!ref || !newSessionWorkspace) return;
		void controller.create(newSessionWorkspace, ref.backend);
	}

	/** Compact the selected session's context (OW-72). */
	function compactSession(): void {
		void controller.compact();
	}

	/** Promote a read-only preview into a live session via the existing attach path, then focus the prompt. */
	async function attachSelected(): Promise<void> {
		const ref = view.preview?.ref;
		if (!ref) return;
		await controller.select(ref);
		await tick();
		promptEl?.focus();
	}

	/**
	 * Take an earlier user message back into the composer (OW-hezidi). No request
	 * is issued and no server state changes: this is the free, abandonable half
	 * of the gesture, and everything else here exists to keep it that way.
	 */
	function startEdit(index: number): void {
		const messages = selectedSession?.messages ?? [];
		const message = messages[index];
		if (!message || message.role !== "user") return;
		let ordinal = 0;
		for (let i = 0; i < index; i++) if (messages[i]?.role === "user") ordinal += 1;
		const text: string[] = [];
		// Carried, not dropped: `PromptRequest.images` takes them back, and a fork
		// that quietly sent fewer images than the original held is exactly the
		// surprise the button labels above exist to prevent.
		const images: { mimeType: string; base64: string }[] = [];
		for (const block of userBlocks(message.content)) {
			if (block.type === "text") text.push(block.text);
			else if (block.type === "image") images.push({ mimeType: block.mimeType, base64: block.data });
		}
		editing = { index, ordinal, images, stashedDraft: view.draft };
		controller.setDraft(text.join("\n\n"));
		promptEl?.focus();
	}

	/**
	 * Redoing the last thing you said, without scrolling back to find it
	 * (OW-relehi). It is the transcript's own edit gesture reached from the
	 * composer, so it goes through `startEdit` and repeats none of it: any
	 * divergence between the two would be a defect, not a feature.
	 *
	 * Streaming, this stops the turn at the click rather than at submit -- the
	 * one exception to OW-hezidi's free-and-abandonable rule, and it says so in
	 * its own name. The fill runs first and the abort is not awaited. Awaiting it
	 * would buy nothing: `controller.abort` never clears `isStreaming`, only a
	 * server event does, so the primary button reads "Stop and fork" either way.
	 * And it would cost something -- through that whole round trip the composer
	 * would still hold the old draft under a button reading "Send", where a
	 * Ctrl-Enter prompts the running session instead of forking it. Filled first,
	 * "Stop and fork" is the truth: `forkAndSubmit` re-checks `isStreaming` and
	 * aborts again before it forks.
	 */
	function editLastMessage(): void {
		const index = lastUserIndex;
		if (index === null) return;
		startEdit(index);
		if (streamingNow) void controller.abort();
	}

	/** Abandon the edit: mark cleared, tail undimmed, displaced draft put back. */
	function cancelEdit(): void {
		if (!editing) return;
		controller.setDraft(editing.stashedDraft);
		editing = null;
	}

	/**
	 * The composer's one send path. Editing, it forks at the marked message and
	 * sends into the fork; otherwise it prompts the selected session.
	 *
	 * The edit mode is cleared only once the fork has actually landed. A failed
	 * fork leaves the draft as the edited text, and clearing the mark under it
	 * would leave a composer saying nothing about where it is about to send.
	 */
	function send(): void {
		if (!view.draft) return;
		const edit = editing;
		armFollow(edit?.index);
		armBadge();
		if (!edit) {
			void controller.submit();
			return;
		}
		const armedKey = view.state.selected ? sessionKey(view.state.selected) : null;
		void controller.forkAndSubmit(edit.ordinal, edit.images).then((sent) => {
			// Pi's fork renames, and `rekeySession` has already run off that event.
			// Codex's does not -- it hands back a ref nothing was renamed to -- so
			// this is where the follow armed above catches up with it. A no-op
			// whenever the key did not move, including a fork that failed.
			const now = view.state.selected;
			if (armedKey && now) rekeySession(armedKey, sessionKey(now));
			if (sent && editing === edit) editing = null;
		});
	}

	function submitPrompt(event: SubmitEvent): void {
		event.preventDefault();
		send();
	}

	/**
	 * Ctrl/Cmd-Enter submits; plain Enter inserts a newline (prompts are
	 * routinely multi-line). Escape abandons an edit -- a second way out, never
	 * the only one: D14 puts Cancel in the banner where a pointer can reach it.
	 */
	function handlePromptKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape" && editing) {
			event.preventDefault();
			cancelEdit();
			return;
		}
		if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
		event.preventDefault();
		send();
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
					<option value="claude">claude</option>
				</select>
			</label>
			<button type="button" onclick={createSession} disabled={!newSessionWorkspace}>New</button>
		</div>
		<!-- The same control drives attached and stored transcripts. -->
		<button type="button" aria-pressed={reading} onclick={() => (reading = !reading)}>Reading view</button>
	</section>

	<div class="sessions-header">
		<h2 id="sessions-heading">Sessions</h2>
		<button type="button" onclick={() => void controller.refreshSessions()}>Refresh</button>
	</div>

	<nav class="sessions" aria-labelledby="sessions-heading">
		{#each filteredSummaries as summary (sessionKey(summary.ref))}
			{@const label = sessionLabel(summary)}
			<!-- The summary's `isStreaming` is right only at the instant the list
			     was read; `state.sessions` is the live map the transcript uses and
			     is updated by every `status` event (OW-furinu). Prefer it where it
			     has an entry. A per-row lookup deliberately, not a field on the
			     summary: it leaves `sortedSummaries` out of the streaming path,
			     which is OW-jineli's whole point. -->
			{@const streaming = view.state.sessions[sessionKey(summary.ref)]?.isStreaming ?? summary.isStreaming}
			<button
				type="button"
				class="session-select"
				class:session-attached={summary.status === "attached"}
				aria-pressed={view.state.selected !== null && sessionKey(view.state.selected) === sessionKey(summary.ref)}
				aria-label={summary.status === "attached" ? `${label} (attached)` : label}
				onclick={() => void controller.preview(summary.ref)}
			>
				<span class="session-preview">{label}</span>
				<span class="session-meta">
					<span
						class="session-backend"
						style="color: {backendColor(summary.ref.backend)}"
					>{summary.ref.backend}</span>
					{#if formatTimestamp(summary.updatedAt)}
						<time class="session-time" datetime={summary.updatedAt ?? undefined}>
							{formatTimestamp(summary.updatedAt)}
						</time>
					{/if}
					{#if summary.cwd}
						<span class="session-cwd" title={summary.cwd}>{basename(summary.cwd)}</span>
					{/if}
					{#if streaming}
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
			<!-- Read-only and non-attaching (OW-38/OW-39), but structurally the same
			     transcript as the live path. No `onedit` keeps it read-only. -->
			<Transcript messages={previewMessageList} {reading} />
		{:else}
			<Transcript
				messages={selectedSession?.messages ?? []}
				isStreaming={selectedSession?.isStreaming ?? false}
				{reading}
				editingIndex={editing?.index ?? null}
				onedit={startEdit}
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
			<!-- The mode banner (OW-hezidi). It does the explaining, which is what
			     lets the buttons stay short, and it is where the cancel control
			     lives: a bare glyph reads as "dismiss this notice", not "abandon my
			     edit". "conversation", not "session" -- the Tools menu already says
			     "New conversation", and `session` is the protocol's word. -->
			{#if editing}
				<p class="edit-banner" role="status">
					<span>Editing an earlier message. Forking starts a new conversation from here and keeps this one.</span>
					<button type="button" onclick={cancelEdit}>Cancel</button>
				</p>
			{/if}
			{#if looksLikeSlashCommand}
				<p class="warning">Agentpane does not run slash commands — this will be sent to the agent as plain text.</p>
			{/if}
			<textarea
				aria-label="Prompt"
				bind:this={promptEl}
				value={view.draft}
				oninput={(event) => controller.setDraft(event.currentTarget.value)}
				onkeydown={handlePromptKeydown}
				placeholder="Ask the agent…"
			></textarea>
			<div class="prompt-actions">
				<!-- A popover, not the <details> OW-72 first reached for (OW-80): a
				     disclosure widget never light-dismisses, while an auto popover
				     gets outside-click and Escape for free, with no JS. The entries
				     hide it declaratively because activating a control *inside* an
				     auto popover does not dismiss it -- verified in Chromium, the
				     menu stayed open -- so only a click outside would close it. -->
				<button type="button" class="tools-menu" popovertarget="tools-menu">Tools</button>
				<div id="tools-menu" popover class="tools-menu-list" role="menu">
					<button
						type="button"
						role="menuitem"
						popovertarget="tools-menu"
						popovertargetaction="hide"
						onclick={newConversation}
						disabled={view.state.selected === null}
					>New conversation</button>
					<button
						type="button"
						role="menuitem"
						popovertarget="tools-menu"
						popovertargetaction="hide"
						onclick={compactSession}
						disabled={view.state.selected === null || view.busy === "compacting"}
					>Compact</button>
				</div>
				<!-- Beside Send and Stop, deliberately not in the Tools popover
				     (OW-relehi): that menu holds the rare things, and going back to
				     the last message is the frequent one. -->
				{#if lastUserIndex !== null}
					<button type="button" onclick={editLastMessage}>
						{streamingNow ? "Stop and edit" : "Edit last message"}
					</button>
				{/if}
				<button type="submit" disabled={!view.draft}>{sendLabel}</button>
				{#if streamingNow}
					<button type="button" class="abort" onclick={() => void controller.abort()}>Stop</button>
				{/if}
			</div>
		</form>
	{/if}
</main>
