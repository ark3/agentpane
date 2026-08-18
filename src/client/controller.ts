import type {
	BackendId,
	ServerEvent,
	SessionPreviewTurn,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";
import { sessionKey } from "$shared/protocol.ts";
import type { AgentpaneApi, EventConnection, EventHandlers } from "./api.ts";
import { nextPreviewDelay, PREVIEW_POLL_FAST_MS, PREVIEW_POLL_IDLE_MS } from "./preview-poll.ts";
import {
	clearSessionError,
	initialClientState,
	reduceServerEvent,
	type ClientState,
} from "./session-state.ts";

export interface ControllerView {
	state: ClientState;
	draft: string;
	connection: "connecting" | "connected" | "reconnecting";
	busy: "idle" | "listing" | "attaching" | "submitting" | "aborting" | "compacting";
	error: string | null;
	/**
	 * Read-only transcript of the selected session (OW-39), when it is being
	 * *previewed* rather than attached. Null once the session is attached (a
	 * live transcript takes over) or when nothing is being previewed. Its `ref`
	 * always equals `state.selected` while non-null.
	 */
	preview: { ref: SessionRef; turns: SessionPreviewTurn[] } | null;
}

export interface AgentpaneController {
	getView(): ControllerView;
	subscribe(listener: (view: ControllerView) => void): () => void;
	/** Fires synchronously, ahead of the state publish, when a `renamed` event arrives (D9). */
	onRename(listener: (from: SessionRef, to: SessionRef) => void): () => void;
	start(): Promise<void>;
	dispose(): void;
	setDraft(text: string): void;
	create(cwd: string, backend: BackendId): Promise<void>;
	/**
	 * Cheap, read-only selection (OW-39): load OW-38's non-attaching preview for
	 * a stored session, or -- if the session is already attached -- just reselect
	 * its live transcript. Spawns nothing for a stored session.
	 */
	preview(ref: SessionRef): Promise<void>;
	select(ref: SessionRef): Promise<void>;
	submit(): Promise<void>;
	abort(): Promise<void>;
	/** Compact the selected session's context (OW-72); no-op with nothing selected. */
	compact(): Promise<void>;
	/** Re-list sessions from disk (dedup'd against any in-flight listing already running). */
	refreshSessions(): Promise<void>;
	/**
	 * Re-read the previewed session's transcript now (OW-76): a no-op with
	 * nothing previewed or with the tab hidden. Call it when the tab comes back
	 * to the foreground; `refreshSessions` already calls it, and while a preview
	 * is on screen an adaptive poll calls it on its own.
	 */
	refreshPreview(): Promise<void>;
	/** Dismiss the current error -- the view-level one and, if selected, the session's own. */
	clearError(): void;
}

/**
 * `isVisible` is *injected* rather than read from `document` because this module
 * has no DOM dependency and must not acquire one (OW-76): the timer and the
 * refresh live here, where they can be driven by a fake api, while the
 * `visibilitychange`/`focus` listeners that feed this predicate live in
 * `App.svelte`, which already owns effects and lifecycle. Defaults to visible so
 * a caller with no tab to speak of -- a test -- gets the poll.
 */
export function createController(
	api: AgentpaneApi,
	isVisible: () => boolean = () => true,
): AgentpaneController {
	let view: ControllerView = {
		state: initialClientState(),
		draft: "",
		connection: "connecting",
		busy: "idle",
		error: null,
		preview: null,
	};
	let connection: EventConnection | undefined;
	let disposed = false;
	let started = false;
	let selectionIntent = 0;
	let refreshInFlight: Promise<void> | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let pollDelay = PREVIEW_POLL_IDLE_MS;
	const recoveries = new Map<string, Promise<void>>();
	const listeners = new Set<(next: ControllerView) => void>();
	const renameListeners = new Set<(from: SessionRef, to: SessionRef) => void>();

	function publish(next: Partial<ControllerView>): void {
		if (disposed) return;
		view = { ...view, ...next };
		for (const listener of listeners) listener(view);
	}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function replaceSummary(summary: SessionSummary, requested: SessionRef): ClientState {
		const summaries = view.state.summaries.filter((item) => {
			const key = sessionKey(item.ref);
			return key !== sessionKey(summary.ref) && key !== sessionKey(requested);
		});
		return { ...view.state, summaries: [...summaries, summary] };
	}

	function applyAttached(summary: SessionSummary, select: boolean, requested: SessionRef): void {
		const selected = select ||
			(view.state.selected !== null && sessionKey(view.state.selected) === sessionKey(requested))
			? summary.ref
			: view.state.selected;
		// An explicit attach replaces any read-only preview with the live transcript.
		publish({ state: { ...replaceSummary(summary, requested), selected }, error: null, ...(select ? { preview: null } : {}) });
	}

	function validWorkspace(cwd: string): boolean {
		if (cwd.startsWith("/")) return true;
		publish({ error: "Workspace must be an absolute path." });
		return false;
	}

	// Always lists the whole corpus: the workspace filter is a client-side view
	// over these summaries now (OW-39), not a server round-trip -- which also
	// retires OW-3's per-keystroke enumeration at the source.
	async function refreshSessions(): Promise<void> {
		if (refreshInFlight) return refreshInFlight;
		const request = (async () => {
			publish({ busy: "listing", error: null });
			// Refresh has to move the transcript too, not just the sidebar (OW-76):
			// before this, pressing it left a stale preview under a freshened list.
			// Concurrent with the listing -- two independent reads -- and awaited so
			// the button's promise covers both.
			const previewRefresh = refreshPreview();
			try {
				const summaries = await api.listSessions(undefined);
				if (!disposed) publish({ state: { ...view.state, summaries }, error: null });
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && view.busy === "listing") publish({ busy: "idle" });
			}
			await previewRefresh;
		})();
		refreshInFlight = request;
		void request.finally(() => {
			if (refreshInFlight === request) refreshInFlight = undefined;
		});
		return request;
	}

	/**
	 * Re-read the transcript already on screen and replace its turns, reporting
	 * whether it grew. False for every reason not to touch anything: nothing
	 * previewed, a stale result, a failed fetch.
	 */
	async function refetchPreview(): Promise<boolean> {
		const showing = view.preview;
		if (!showing) return false;
		const ref = showing.ref;
		// A refresh is not a new selection, so it *captures* the selection intent
		// instead of bumping it -- bumping would silently cancel a click whose own
		// preview or attach is still in flight. Comparing it back afterwards is
		// what keeps a refresh that resolves late from resurrecting a preview the
		// user has already left.
		const intent = selectionIntent;
		let turns: SessionPreviewTurn[];
		try {
			turns = (await api.preview(ref)).turns;
		} catch {
			// The pane still shows the last good read and the next tick retries. A
			// background poll has no business seizing the view's error slot.
			return false;
		}
		if (disposed || intent !== selectionIntent) return false;
		// Re-read rather than reusing `showing`: another refresh may have published
		// in the meantime. The intent guard above has already covered the ref
		// *changing* under us -- every writer of `view.preview` bumps
		// `selectionIntent` -- so this is the narrowing, not a second guard.
		const current = view.preview;
		if (!current) return false;
		// `turns.length` is the change test, decided 2026-08-18: both extractors map
		// one JSONL record to at most one turn (`pi.ts:119`, `codex.ts:192`) and a
		// JSONL only appends, so new content is always new turns -- while the last
		// turn's `timestamp` is optional (OW-71) and would compare undefined to
		// undefined forever. Nothing is published when the length is unchanged, so a
		// quiet poll costs the transcript no re-render.
		if (turns.length === current.turns.length) return false;
		// Keeps the preview's own ref rather than the response's, so the documented
		// `preview.ref === state.selected` invariant holds without touching
		// `selected` -- a refresh must never move the selection.
		publish({ preview: { ref: current.ref, turns } });
		return true;
	}

	function stopPoll(): void {
		if (pollTimer !== undefined) clearTimeout(pollTimer);
		pollTimer = undefined;
	}

	/**
	 * Match the timer to the current view. Idempotent on purpose: a gesture that
	 * found nothing must not restart the countdown, or a busy client could starve
	 * the poll forever. Callers that mean to apply a new delay `stopPoll()` first.
	 *
	 * Only the sites that *start* a poll call this. Nothing calls it to stop one
	 * when the preview goes away -- attaching, or reselecting a live session --
	 * because `pollTick` re-evaluates here on the way out and disarms itself, so
	 * the worst an attach leaves behind is a single wake-up that fetches nothing.
	 * One invariant in one place beats a `syncPoll()` at every publish that might
	 * have cleared the preview, which is a thing to forget.
	 *
	 * A chained timeout, not `setInterval`: the delay changes on every tick, and
	 * this way a slow fetch cannot overlap the next one.
	 */
	function syncPoll(): void {
		if (disposed || view.preview === null || !isVisible()) {
			stopPoll();
			return;
		}
		if (pollTimer !== undefined) return;
		pollTimer = setTimeout(() => {
			pollTimer = undefined;
			void pollTick();
		}, pollDelay);
	}

	async function pollTick(): Promise<void> {
		const changed = await refetchPreview();
		if (disposed) return;
		// Only a timer tick backs the delay off -- see `nextPreviewDelay`.
		pollDelay = nextPreviewDelay(pollDelay, changed);
		syncPoll();
	}

	/** A refresh driven by a gesture or a returning tab, rather than by the timer. */
	async function refreshPreview(): Promise<void> {
		if (!isVisible()) {
			// Never poll a hidden tab: this is also the path that stops the timer
			// when `visibilitychange` fires on the way *out*.
			stopPoll();
			return;
		}
		const changed = await refetchPreview();
		if (disposed) return;
		if (changed) {
			pollDelay = PREVIEW_POLL_FAST_MS;
			stopPoll();
		}
		syncPoll();
	}

	async function recover(ref: SessionRef): Promise<void> {
		const key = sessionKey(ref);
		const inFlight = recoveries.get(key);
		if (inFlight) return inFlight;
		const request = (async () => {
			publish({ busy: "attaching", error: null });
			try {
				const attached = await api.attach(ref);
				if (!disposed) applyAttached(attached, false, ref);
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && view.busy === "attaching") publish({ busy: "idle" });
			}
		})();
		recoveries.set(key, request);
		void request.finally(() => {
			if (recoveries.get(key) === request) recoveries.delete(key);
		});
		return request;
	}

	async function attachAndSelect(ref: SessionRef, intent: number): Promise<void> {
		publish({ busy: "attaching", error: null });
		try {
			const attached = await api.attach(ref);
			if (!disposed && intent === selectionIntent) {
				applyAttached(attached, true, ref);
			} else if (!disposed) {
				// An older attach is still useful list state, but it no longer owns
				// selection after a newer user intent.
				publish({ state: replaceSummary(attached, ref) });
			}
		} catch (error: unknown) {
			if (!disposed && intent === selectionIntent) publish({ error: errorMessage(error) });
		} finally {
			if (!disposed && intent === selectionIntent && view.busy === "attaching") {
				publish({ busy: "idle" });
			}
		}
	}

	const handlers: EventHandlers = {
		onEvent(event: ServerEvent) {
			if (disposed) return;
			const result = reduceServerEvent(view.state, event);
			if (event.type === "renamed") {
				for (const listener of renameListeners) listener(event.from, event.session);
			}
			if (result.state !== view.state) publish({ state: result.state });
			for (const ref of result.recover) void recover(ref);
			if (result.refreshSessions) void refreshSessions();
		},
		onOpen() {
			publish({ connection: "connected" });
		},
		onDisconnect() {
			publish({ connection: "reconnecting" });
		},
		onMalformed(error: Error) {
			publish({ error: error.message });
		},
	};

	return {
		getView() {
			return view;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onRename(listener) {
			renameListeners.add(listener);
			return () => renameListeners.delete(listener);
		},
		refreshSessions,
		refreshPreview,
		async start() {
			if (disposed || started) return;
			started = true;
			connection = api.connect(handlers);
			await refreshSessions();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			stopPoll();
			connection?.close();
			listeners.clear();
		},
		setDraft(text) {
			publish({ draft: text });
		},
		async preview(ref) {
			const intent = ++selectionIntent;
			// A session already attached in this client keeps its live transcript --
			// there is nothing to preview, so just reselect it (no fetch, no re-attach).
			if (view.state.sessions[sessionKey(ref)]) {
				publish({ state: { ...view.state, selected: ref }, preview: null, error: null });
				return;
			}
			publish({ error: null });
			try {
				const response = await api.preview(ref);
				if (!disposed && intent === selectionIntent) {
					publish({
						state: { ...view.state, selected: response.ref },
						preview: { ref: response.ref, turns: response.turns },
						error: null,
					});
					// A freshly opened preview starts quiet, whatever the last one settled at.
					pollDelay = PREVIEW_POLL_IDLE_MS;
					stopPoll();
					syncPoll();
				}
			} catch (error: unknown) {
				if (!disposed && intent === selectionIntent) publish({ error: errorMessage(error) });
			}
		},
		async create(cwd, backend) {
			if (!validWorkspace(cwd)) return;
			const intent = ++selectionIntent;
			publish({ busy: "attaching", error: null });
			try {
				const created = await api.createSession({ cwd, backend });
				if (!disposed && intent === selectionIntent) await attachAndSelect(created, intent);
			} catch (error: unknown) {
				if (!disposed && intent === selectionIntent) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && intent === selectionIntent && view.busy === "attaching") {
					publish({ busy: "idle" });
				}
			}
		},
		async select(ref) {
			await attachAndSelect(ref, ++selectionIntent);
		},
		async submit() {
			const selected = view.state.selected;
			if (!selected) {
				publish({ error: "Select a session before submitting a prompt." });
				return;
			}
			if (!view.draft) return;
			const text = view.draft;
			// Track the target session through a possible rename (D9) while the
			// request is in flight, and remember its error so success only clears
			// it if nothing new landed via SSE in the meantime -- cross-event
			// ordering relative to the POST response is not guaranteed (D2), so a
			// same-turn error can otherwise race in and be wiped by this same
			// submit's own success handler.
			let ref = selected;
			const priorError = view.state.sessions[sessionKey(selected)]?.error ?? null;
			const onRename = (from: SessionRef, to: SessionRef) => {
				if (sessionKey(from) === sessionKey(ref)) ref = to;
			};
			renameListeners.add(onRename);
			publish({ busy: "submitting", error: null });
			try {
				await api.prompt(selected, { text });
				if (!disposed) {
					const currentError = view.state.sessions[sessionKey(ref)]?.error ?? null;
					const state = currentError === priorError ? clearSessionError(view.state, ref) : view.state;
					publish({ draft: "", error: null, state });
				}
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
			} finally {
				renameListeners.delete(onRename);
				if (!disposed && view.busy === "submitting") publish({ busy: "idle" });
			}
		},
		async abort() {
			const selected = view.state.selected;
			if (!selected) {
				publish({ error: "Select a session before aborting." });
				return;
			}
			publish({ busy: "aborting", error: null });
			try {
				await api.abort(selected);
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && view.busy === "aborting") publish({ busy: "idle" });
			}
		},
		async compact() {
			const selected = view.state.selected;
			if (!selected) {
				publish({ error: "Select a session before compacting." });
				return;
			}
			publish({ busy: "compacting", error: null });
			try {
				await api.compact(selected);
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && view.busy === "compacting") publish({ busy: "idle" });
			}
		},
		clearError() {
			const selected = view.state.selected;
			const state = selected ? clearSessionError(view.state, selected) : view.state;
			publish({ error: null, state });
		},
	};
}
