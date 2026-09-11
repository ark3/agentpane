import type {
	BackendId,
	ModelInfo,
	PromptRequest,
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
	replaceSessionSummaries,
	setSessionCompaction,
	type ClientState,
} from "./session-state.ts";

export interface ControllerView {
	state: ClientState;
	draft: string;
	connection: "connecting" | "connected" | "reconnecting";
	busy: "idle" | "listing" | "attaching" | "submitting" | "aborting" | "compacting" | "editing-externally";
	/**
	 * A prompt this controller sent is still in flight: `submit`'s single POST,
	 * or `forkAndSubmit`'s whole abort/fork-points/fork/attach/prompt round trip.
	 * Those two own it between them, and both re-entrancy guards -- the one in
	 * each of them, and `send()`'s in `App.svelte` -- read it (OW-kelede).
	 *
	 * `busy` cannot serve: it is one global slot every operation writes, and two
	 * of them clear it out from under a live POST. `abort` publishes `"aborting"`
	 * and then `"idle"` in its `finally`, and `attachAndSelect` does the same with
	 * `"attaching"` -- so pressing Stop on a turn that is already streaming (D2
	 * lets SSE precede the POST response) left `busy: "idle"` with the prompt
	 * still outstanding, and a second press went through.
	 */
	sending: boolean;
	error: string | null;
	/** Live options for the selected empty conversation only. */
	models: ModelInfo[];
	/** Only the picker is disabled while this request is in flight. */
	modelSetting: boolean;
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
	/** Round-trip the current draft through the server process's external editor. */
	editDraft(): Promise<void>;
	create(cwd: string, backend: BackendId): Promise<void>;
	/**
	 * Cheap, read-only selection (OW-39): load OW-38's non-attaching preview for
	 * a stored session, or -- if the session is already attached -- just reselect
	 * its live transcript. Spawns nothing for a stored session.
	 */
	preview(ref: SessionRef): Promise<void>;
	select(ref: SessionRef): Promise<void>;
	/**
	 * Send the current draft to the selected session.
	 *
	 * Resolves **true** only when the prompt landed, the way `forkAndSubmit`
	 * below does, because there are three ways for it not to -- nothing
	 * selected, an empty draft or a prompt already in flight, and a rejected
	 * POST -- and the caller arms per-tab state on a submit that only the answer
	 * here can tell it to take back down (OW-mifuki).
	 */
	submit(): Promise<boolean>;
	/**
	 * Fork the selected session just before its `ordinal`-th user message and
	 * send the current draft, plus `images`, into the fork (OW-hezidi). Always a
	 * new session: no backend is asked to rewind in place, and Codex cannot.
	 *
	 * The ordinal indexes `GET fork-points`, which answers one point per user
	 * message in transcript order on every backend -- the caller counts user
	 * messages and never matches on wording, which two identical messages break.
	 *
	 * Resolves to **the ref the prompt landed on**, or null if it never landed.
	 * The ref rather than a boolean because the caller has per-tab state keyed on
	 * the session it armed before the fork -- scroll, follow, the badge -- and has
	 * to move it onto the fork; reading `state.selected` back instead would move
	 * it onto whatever the user clicked mid-fork (OW-mifuki).
	 *
	 * Null means a genuine failure -- nothing selected, an empty draft, a press
	 * on top of one still in flight, a missing fork point, or a rejected request.
	 * Clicking another session mid-fork is not one of them: under D17 that is
	 * navigation, not a retraction, so the round trip runs to completion and the
	 * ref comes back while the selection stays where the click put it
	 * (OW-miyemo).
	 *
	 * The caller owns the compose mode this drives, and a failed fork has to
	 * leave that mode standing: the draft is still the edited text, and clearing
	 * the mark under it would leave a composer that says nothing about where it
	 * is about to send.
	 */
	forkAndSubmit(ordinal: number, images?: PromptRequest["images"]): Promise<SessionRef | null>;
	abort(): Promise<void>;
	/** Compact the selected session's context (OW-72); no-op with nothing selected. */
	compact(): Promise<void>;
	setModel(model: string): Promise<void>;
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
		sending: false,
		error: null,
		models: [],
		modelSetting: false,
		preview: null,
	};
	let connection: EventConnection | undefined;
	let disposed = false;
	let started = false;
	let selectionIntent = 0;
	let modelLoadStartedForSelection: number | null = null;
	const pendingModelSets = new Set<string>();
	let refreshInFlight: Promise<void> | undefined;
	let refreshSurfacing = false;
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

	function busyIs(value: ControllerView["busy"]): boolean {
		return view.busy === value;
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
		// An explicit attach replaces any read-only preview with the live
		// transcript, and clears the error slot the gesture is answering. Both are
		// gated on `select` because neither caller that passes `false` has any
		// standing over them: `recover`, which no gesture reaches -- see its
		// docblock (OW-yasewo) -- and a `forkAndSubmit` the user has clicked away
		// from, which under D17 still lands its prompt but owns neither the error
		// slot nor the preview of the session they went to (OW-miyemo).
		publish({ state: { ...replaceSummary(summary, requested), selected }, ...(select ? { error: null, preview: null } : {}) });
	}

	function validWorkspace(cwd: string): boolean {
		if (cwd.startsWith("/")) return true;
		publish({ error: "Workspace must be an absolute path." });
		return false;
	}

	function modelSettingForSession(ref: SessionRef | null): boolean {
		return ref !== null && pendingModelSets.has(sessionKey(ref));
	}

	async function loadModelsForSelected(intent: number): Promise<void> {
		const selected = view.state.selected;
		if (!selected) return;
		const key = sessionKey(selected);
		if (view.state.sessions[key]?.messages.length !== 0) return;
		if (modelLoadStartedForSelection === intent) return;
		modelLoadStartedForSelection = intent;
		publish({ models: [], error: null });
		try {
			const models = await api.listModels(selected.backend);
			const current = view.state.selected;
			if (!disposed && selectionIntent === intent && current && sessionKey(current) === key && view.state.sessions[key]?.messages.length === 0) {
				publish({ models });
			}
		} catch (error: unknown) {
			const current = view.state.selected;
			if (!disposed && selectionIntent === intent && current && sessionKey(current) === key) publish({ error: errorMessage(error) });
		}
	}

	// Always lists the whole corpus: the workspace filter is a client-side view
	// over these summaries now (OW-39), not a server round-trip -- which also
	// retires OW-3's per-keystroke enumeration at the source.
	//
	// `surface` separates the two callers (OW-dinuwu). A gesture -- the Refresh
	// button, or the startup list -- owns the status line and the error slot and
	// says so. A `sessions-changed` broadcast owns neither, and it is far more
	// frequent than it looks: the server fires it at every turn boundary to keep
	// the `updatedAt` sort moving (OW-furinu), so one lands inside the
	// `"submitting"` of every prompt, not just the first one's rename. Surfacing
	// that wiped errors the user had not read yet and wrote `busy: "listing"`
	// over the `"attaching"` or `"submitting"` of the very operation that caused
	// the broadcast -- which defeated `submit`'s one-prompt-at-a-time guard
	// (OW-nasofa) outright.
	async function refreshSessions(surface: boolean): Promise<void> {
		if (refreshInFlight) {
			// A press that joins a listing already in flight still owns the error
			// slot; silence is only for the listings nobody asked for. Without this
			// a Refresh during a broadcast re-list -- likely, since turns broadcast
			// -- would report nothing at all when the listing fails.
			if (surface) refreshSurfacing = true;
			return refreshInFlight;
		}
		refreshSurfacing = surface;
		const request = (async () => {
			if (refreshSurfacing) publish({ busy: "listing", error: null });
			// Refresh has to move the transcript too, not just the sidebar (OW-76):
			// before this, pressing it left a stale preview under a freshened list.
			// Concurrent with the listing -- two independent reads -- and awaited so
			// the button's promise covers both.
			const previewRefresh = refreshPreview();
			try {
				const sessionsWhenListed = view.state.sessions;
				const summaries = await api.listSessions(undefined);
				if (!disposed) {
					publish({ state: replaceSessionSummaries(view.state, summaries, sessionsWhenListed) });
				}
			} catch (error: unknown) {
				if (!disposed && refreshSurfacing) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && refreshSurfacing && view.busy === "listing") publish({ busy: "idle" });
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

	/**
	 * Re-attach a session whose SSE sequence gapped (`acceptsSequence` in
	 * `session-state.ts`), which means this client dropped an event. Nothing
	 * user-driven reaches here: the only caller is `onEvent`, so every recovery is
	 * background repair, for whichever session gapped -- not necessarily the
	 * selected one.
	 *
	 * It therefore writes neither `busy` nor `error`, deliberately, and does not
	 * report its own failure (OW-yasewo; OW-dinuwu is the same defect through the
	 * re-list door). `busy` is one global slot naming what the user's own last
	 * gesture is doing: `"attaching"` here wrote "Opening session…" over the
	 * "Sending prompt…" of a prompt the user was watching in another session, and
	 * the `finally`'s `busy: "idle"` cut a genuine `attachAndSelect`'s status short
	 * as well. The error slot is mail the user has not read; a recovery nobody
	 * asked for has no standing to empty it, and a failed one has none to fill it
	 * either -- an error with no gesture behind it is unattributable, and the
	 * remedy is automatic anyway: the next event for that session gaps again and
	 * retries, and a Refresh re-lists regardless. A background attach that reports
	 * nothing is the intended behaviour, not an oversight.
	 */
	async function recover(ref: SessionRef): Promise<void> {
		const key = sessionKey(ref);
		const inFlight = recoveries.get(key);
		if (inFlight) return inFlight;
		const request = (async () => {
			try {
				const attached = await api.attach(ref);
				if (!disposed) applyAttached(attached, false, ref);
			} catch {
				// Silent by design -- see the docblock above.
			}
		})();
		recoveries.set(key, request);
		void request.finally(() => {
			if (recoveries.get(key) === request) recoveries.delete(key);
		});
		return request;
	}

	async function attachAndSelect(ref: SessionRef, intent: number): Promise<void> {
		publish({ busy: "attaching", error: null, models: [], modelSetting: modelSettingForSession(ref) });
		try {
			const attached = await api.attach(ref);
			if (!disposed && intent === selectionIntent) {
				applyAttached(attached, true, ref);
				publish({ modelSetting: modelSettingForSession(view.state.selected) });
				await loadModelsForSelected(intent);
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
			if (event.type === "snapshot" && result.state.selected && sessionKey(result.state.selected) === sessionKey(event.session)) {
				void loadModelsForSelected(selectionIntent);
			}
			for (const ref of result.recover) void recover(ref);
			if (result.refreshSessions) void refreshSessions(false);
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
		refreshSessions: () => refreshSessions(true),
		refreshPreview,
		async start() {
			if (disposed || started) return;
			started = true;
			connection = api.connect(handlers);
			await refreshSessions(true);
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
				publish({
					state: { ...view.state, selected: ref },
					preview: null,
					error: null,
					models: [],
					modelSetting: modelSettingForSession(ref),
				});
				await loadModelsForSelected(intent);
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
		async setModel(model) {
			const selected = view.state.selected;
			if (!selected || modelSettingForSession(selected) || view.state.sessions[sessionKey(selected)]?.messages.length !== 0) return;
			let key = sessionKey(selected);
			const onRename = (from: SessionRef, to: SessionRef) => {
				if (sessionKey(from) !== key) return;
				pendingModelSets.delete(key);
				key = sessionKey(to);
				pendingModelSets.add(key);
			};
			renameListeners.add(onRename);
			pendingModelSets.add(key);
			publish({ modelSetting: true, error: null });
			try {
				await api.setModel(selected, model);
			} catch (error: unknown) {
				const current = view.state.selected;
				if (!disposed && current && sessionKey(current) === key) publish({ error: errorMessage(error) });
			} finally {
				renameListeners.delete(onRename);
				pendingModelSets.delete(key);
				if (!disposed) publish({ modelSetting: modelSettingForSession(view.state.selected) });
			}
		},
		async submit() {
			const selected = view.state.selected;
			if (!selected) {
				publish({ error: "Select a session before submitting a prompt." });
				return false;
			}
			// One prompt at a time (OW-nasofa): a second Ctrl-Enter, or Enter then a
			// click on Send, while the POST is in flight would issue a second
			// identical prompt -- the server admits it and what the backend does
			// with it is nobody's intent. Read off `sending` rather than `busy`,
			// which an abort or an attach clears mid-POST (OW-kelede).
			if (view.sending) return false;
			if (!view.draft) return false;
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
			publish({ busy: "submitting", sending: true, error: null });
			try {
				await api.prompt(selected, { text });
				if (!disposed) {
					const currentError = view.state.sessions[sessionKey(ref)]?.error ?? null;
					const state = currentError === priorError ? clearSessionError(view.state, ref) : view.state;
					// The request cleared the global error before starting. Leaving it
					// untouched here preserves any newer failure from concurrent work.
					// The draft clears only if it is still the text that was sent: the
					// textarea stays live through the round trip, so anything typed
					// while waiting is the next prompt, not this one (OW-nasofa).
					publish({ ...(view.draft === text ? { draft: "" } : {}), state });
				}
				return true;
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
				return false;
			} finally {
				renameListeners.delete(onRename);
				publish({ sending: false, ...(view.busy === "submitting" ? { busy: "idle" } : {}) });
			}
		},
		async editDraft() {
			if (view.busy !== "idle") return;
			const text = view.draft;
			publish({ busy: "editing-externally", error: null });
			try {
				const edited = await api.editDraft({ text });
				if (!disposed) publish({ draft: edited.text });
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && busyIs("editing-externally")) publish({ busy: "idle" });
			}
		},
		async forkAndSubmit(ordinal, images) {
			const selected = view.state.selected;
			if (!selected) {
				publish({ error: "Select a session before submitting a prompt." });
				return null;
			}
			// One send at a time, the rule `submit` above states and this path did
			// not have (OW-kelede). Two fast presses in edit mode started two whole
			// forks -- two aborts against the parent, two forks, two attaches and
			// two identical prompts -- and worse: the second one's failure took the
			// *first* fork's follow and badge arming back down with it, because on
			// a renaming backend both presses' armed keys had followed onto the
			// same fork.
			if (view.sending) return null;
			if (!view.draft) return null;
			const text = view.draft;
			// Same rename hazard `submit` above carries (D9), and the fork adds a
			// second source of it: Pi's fork moves the live process onto a new file,
			// which the server reports as `renamed`. So the ref this reads fork
			// points from, and forks, is tracked through any rename in flight.
			let ref = selected;
			const onRename = (from: SessionRef, to: SessionRef) => {
				if (sessionKey(from) === sessionKey(ref)) ref = to;
			};
			renameListeners.add(onRename);
			// Captured first, the way `refetchPreview` captures it: every await
			// below is a window in which the user can click another session, and
			// a fork that reaches its attach after that click must not yank the
			// selection back onto itself (OW-mifuki). That is the *only* thing the
			// click decides: under D17 it is navigation, not a cancel, so the fork
			// is still created, still attached and still prompted, and the user
			// ends up with both conversations (OW-miyemo).
			const intent = selectionIntent;
			publish({ busy: "submitting", sending: true, error: null });
			try {
				// Stop a running turn before forking it, on every backend. Not a
				// first cut any more -- the owner took it deliberately (D15,
				// OW-zekuhe). On Pi there is nothing to choose: the fork abandons
				// the turn whether or not we abort (OW-yudoni), so the abort only
				// makes that loss visible. Codex's parent thread is *believed* to
				// keep streaming, but every observation behind that forked an idle
				// thread (OW-mewiga, OW-pifowo); probing it mid-stream is OW-gojado.
				// A turn that survives streams into a session the user has left.
				if (view.state.sessions[sessionKey(ref)]?.isStreaming) await api.abort(ref);
				if (disposed) return null;
				const points = await api.forkPoints(ref);
				if (disposed) return null;
				const point = points[ordinal];
				if (!point) throw new Error("That message is no longer a fork point in this session.");
				const forked = await api.fork(ref, { entryId: point.id });
				if (disposed) return null;
				// The backends reach "attached to the fork" from opposite directions,
				// and this one line covers all of them. Pi's fork moved the live
				// process onto the new file -- and Claude Code's respawned its child
				// onto the forked session -- so the manager has already re-keyed and
				// this attach finds it; Codex minted a thread nothing is driving, and
				// this attach is what spawns it. A fork is a selection change, so the
				// intent bumps -- a preview poll still in flight must not put its old
				// transcript back over the fork.
				//
				// Only a fork that is actually taking the selection may bump, which
				// is why this is read before the bump destroys what it reads. A fork
				// the user has clicked away from must leave the counter alone:
				// bumping past their own click strands it, leaving their
				// `attachAndSelect` in its `else` branch with the selection never set
				// and `busy` stuck on "attaching" forever (D17, OW-miyemo).
				const takesSelection = intent === selectionIntent;
				const forkIntent = takesSelection ? ++selectionIntent : intent;
				const attached = await api.attach(forked);
				if (disposed) return null;
				// The attach is one more window for a click, and it gets the same
				// answer: the attach still lands, it just does not move the user.
				applyAttached(attached, forkIntent === selectionIntent, forked);
				await api.prompt(attached.ref, { text, ...(images && images.length > 0 ? { images } : {}) });
				if (disposed) return null;
				// The prompt landed, so the composer must stop offering text that has
				// already been sent -- but only if it is still that text. The
				// textarea stays live through a round trip four requests deep, so
				// anything typed while waiting is the next prompt, not this one
				// (OW-nasofa's rule, brought to this path by OW-kelede). It still
				// covers the reason the clear used to be unconditional: the draft is
				// global, and a user who clicked away mid-POST would otherwise be
				// looking at another session with already-sent text under a Send
				// button -- clicking away does not change the draft, so that case
				// still clears.
				//
				// The error clear is gated on the intent instead: a session clicked
				// to in that window may have raised one of its own, and this fork has
				// no claim on that slot.
				publish({
					...(view.draft === text ? { draft: "" } : {}),
					...(forkIntent === selectionIntent ? { error: null } : {}),
				});
				return attached.ref;
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
				return null;
			} finally {
				renameListeners.delete(onRename);
				publish({ sending: false, ...(view.busy === "submitting" ? { busy: "idle" } : {}) });
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
			// Same rename hazard `submit` above carries (D9): the reducer moves the
			// requesting mark to the re-keyed session, so the failure path below has
			// to clear it there, not under the click-time key -- which is gone.
			let ref = selected;
			const onRename = (from: SessionRef, to: SessionRef) => {
				if (sessionKey(from) === sessionKey(ref)) ref = to;
			};
			renameListeners.add(onRename);
			// The session reads "requesting" from the click itself rather than from
			// the server: its own "requesting" status races the POST response (D2),
			// and the composer needs the acknowledgment either way (OW-natiha).
			// Server status/snapshot events overwrite it from here on -- the request
			// resolving is admission, not completion, so nothing here clears it.
			publish({
				busy: "compacting",
				error: null,
				state: setSessionCompaction(view.state, selected, "requesting"),
			});
			try {
				await api.compact(selected);
			} catch (error: unknown) {
				if (!disposed) {
					// Failed admission: nothing is running unless a server event has
					// since said otherwise, so only a still-"requesting" mark clears.
					const current = view.state.sessions[sessionKey(ref)]?.compaction;
					const state = current === "requesting"
						? setSessionCompaction(view.state, ref, null)
						: view.state;
					publish({ error: errorMessage(error), state });
				}
			} finally {
				renameListeners.delete(onRename);
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
