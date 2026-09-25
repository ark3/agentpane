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
	handleOf,
	initialClientState,
	reduceServerEvent,
	replaceSessionSummaries,
	setSessionCompaction,
	viewOf,
	type ClientState,
	type Recovery,
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
	/** The effort select's own flag, as `modelSetting` is the model picker's. */
	effortSetting: boolean;
	/**
	 * Read-only transcript of the selected session (OW-39), when it is being
	 * *previewed* rather than attached. Null once the session is attached (a
	 * live transcript takes over) or when nothing is being previewed. Its `ref`
	 * always equals `state.selected` while non-null.
	 */
	preview: { ref: SessionRef; turns: SessionPreviewTurn[] } | null;
	/**
	 * Transcript indices the *selected* session can be forked at, as of the last
	 * `GET fork-points` (OW-roveze), or null while nobody has been told yet.
	 * Whether a user message is offered an Edit control at all reads this.
	 *
	 * On the view rather than on each `SessionView` because only the selected
	 * session draws Edit controls and only the selected session is ever asked --
	 * and because a `SessionView` write is how `replaceSessionSummaries` tells a
	 * touched session from an untouched one, which a fork-points reply has no
	 * business answering.
	 *
	 * Not-yet-known is a third state on purpose, and it offers every user message
	 * a control: a session is attached and drawn before this can answer, and a
	 * transcript that blinks its controls in a beat later is worse than one whose
	 * worst case for that beat is a refusal. It can only be a refusal --
	 * `forkAndSubmit` resolves the point by index at submit, so an Edit offered
	 * here that the backend cannot honour is declined, never redirected.
	 *
	 * An affordance, not a fact, even once known: it is refreshed at attach and
	 * at turn boundaries, and between a refresh and the click the transcript can
	 * move under it. Nothing is decided on it.
	 */
	forkIndices: number[] | null;
}

export interface AgentpaneController {
	getView(): ControllerView;
	subscribe(listener: (view: ControllerView) => void): () => void;
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
	 * Fork the selected session just before the user message at transcript
	 * `index` and send the current draft, plus `images`, into the fork
	 * (OW-hezidi). Always a new session: no backend is asked to rewind in place,
	 * and Codex cannot.
	 *
	 * `index` addresses the transcript array itself -- the one `snapshot.messages`
	 * carries -- and a fork point is resolved by matching `ForkPoint.index`
	 * against it (OW-roveze). Never by position in the points list: Codex answers
	 * one point per *turn*, a steered turn holds two user messages, so counting
	 * user messages addressed a later turn than the user clicked and forked
	 * there silently. Never by wording either, which two identical messages break.
	 *
	 * No point at that index is a refusal, not a fallback. The caller normally
	 * offers no Edit control on such a message at all, so reaching here means the
	 * transcript moved under the affordance.
	 *
	 * Resolves to **the ref the prompt landed on**, or null if it never landed.
	 * The ref rather than a boolean because the caller has per-tab state keyed on
	 * the session it armed before the fork -- scroll, follow, the badge -- and has
	 * to move it onto the fork; reading `state.selected` back instead would move
	 * it onto whatever the user clicked mid-fork (OW-mifuki).
	 *
	 * Null means a genuine failure -- nothing selected, an empty draft, a press
	 * on top of one still in flight, no fork point at that index, or a rejected
	 * request.
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
	forkAndSubmit(index: number, images?: PromptRequest["images"]): Promise<SessionRef | null>;
	abort(): Promise<void>;
	/** Compact the selected session's context (OW-72); no-op with nothing selected. */
	compact(): Promise<void>;
	/**
	 * End the selected session's subprocess and leave the user on its read-only
	 * preview (OW-tewave), which is where a click on that row would have put
	 * them. No-op with nothing selected.
	 *
	 * The caller decides *when* this is offered -- the composer's Tools menu
	 * gates it on the exemption predicate D12 wrote for its reaper, because
	 * `close()` kills mid-turn and on Claude Code that loses the whole reply
	 * (OW-japuzo). Nothing is re-checked here.
	 */
	detach(): Promise<void>;
	setModel(model: string): Promise<void>;
	setEffort(effort: string): Promise<void>;
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
 * How long to wait before rebuilding an event stream the browser gave up on
 * (OW-dekuri).
 *
 * A fatal close means the server answered *wrongly* -- a 404, or a body that
 * was not `text/event-stream` -- rather than going quiet, so the retry is
 * aimed at a server that is restarting or half-up, and hammering it is the
 * failure mode to avoid: unlike the browser's own retry there is nothing
 * backing this one off. 5s is longer than the browser's ~3s default for the
 * drops it does handle, costs at most twelve requests a minute from a tab left
 * open against a server that never comes back, and still clears a restart
 * within one cycle of it finishing.
 */
const FATAL_STREAM_RETRY_MS = 5_000;

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
		effortSetting: false,
		preview: null,
		forkIndices: null,
	};
	let connection: EventConnection | undefined;
	/** Pending rebuild of a fatally closed stream -- see `FATAL_STREAM_RETRY_MS`. */
	let fatalRetryTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let started = false;
	let selectionIntent = 0;
	let modelLoadStartedForSelection: number | null = null;
	/**
	 * This and every per-session set and map below are keyed by the session's
	 * handle (D24, OW-kimaya), which a rename never moves, so none of them
	 * tracks one: the ref a request was sent on may be renamed while it is in
	 * flight, and the handle it was keyed by still names the same session.
	 */
	const pendingModelSets = new Set<string>();
	const pendingEffortSets = new Set<string>();
	let refreshInFlight: Promise<void> | undefined;
	/** Whether the event stream has ever been up: every open after the first is a reconnect. */
	let opened = false;
	/** Whether any listing has ever landed. `refreshSessions` swallows its failures, so success is not the default. */
	let listedOk = false;
	let refreshSurfacing = false;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let pollDelay = PREVIEW_POLL_IDLE_MS;
	const recoveries = new Map<string, Promise<void>>();
	/** Handles whose `detach` is between `api.close` and the live view being dropped -- see `recover` (OW-sugome). */
	const detaching = new Set<string>();
	const forkPointsInFlight = new Set<string>();
	const listeners = new Set<(next: ControllerView) => void>();

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
		// By ref, not by handle: the ref asked for may have none yet -- a fork's
		// has none until this reply puts the summary carrying it in place
		// (OW-kimaya). The two `select: false` callers say why each keeps it.
		const takesSelection = select ||
			(view.state.selected !== null && sessionKey(view.state.selected) === sessionKey(requested));
		const selected = takesSelection ? summary.ref : view.state.selected;
		// The error slot is gated on `select`, because neither caller that passes
		// `false` has standing over it: `recover`, which no gesture reaches -- see
		// its docblock (OW-yasewo) -- and a `forkAndSubmit` the user has clicked
		// away from, which under D17 still lands its prompt but owns neither the
		// error slot nor the preview of the session they went to (OW-miyemo).
		//
		// The preview is gated on the selection actually landing here instead,
		// which is wider: the residual above also fires with `select: false`, when
		// the click that declined the attach landed on the very ref being attached
		// -- clicking the fork's own row during its round trip (OW-tatebi). The
		// selection moves to the live session, so the read-only preview that click
		// opened has to go with it or it sits frozen over a streaming transcript.
		// This does not loosen `recover`: the session it re-attaches is one this
		// client already had attached, and an attached selection has no preview to
		// clear (see `ControllerView.preview`), so the residual publishes a null
		// that is already null.
		publish({
			state: { ...replaceSummary(summary, requested), selected },
			...(select ? { error: null } : {}),
			...(takesSelection ? { preview: null } : {}),
		});
		// Only where the transcript is about to be drawn with Edit controls on it
		// (OW-roveze); a background `recover` renders nothing and needs none.
		if (takesSelection) refreshForkPoints(summary.ref);
	}

	/**
	 * Re-ask the server which transcript indices this session can be forked at,
	 * so the transcript knows where to draw an Edit control (OW-roveze).
	 *
	 * Cheap and best-effort. The client used to need nothing from the server to
	 * decide this -- it counted user messages -- and that count is what was
	 * wrong. It is paid for at attach and at each turn boundary, which are the
	 * moments the set can change, and never per message.
	 *
	 * A failure is swallowed. This fills in an affordance, not an operation: the
	 * user asked for nothing, so there is nobody to report to, and the last known
	 * set standing is the same staleness the window between two refreshes already
	 * has. `forkAndSubmit` refetches at submit and reports its own failures, and
	 * it is the one that decides anything.
	 */
	function refreshForkPoints(ref: SessionRef): void {
		// Keyed by the handle, so a rename landing while the request is in
		// flight leaves the check below true: the selection follows the ref and
		// still names the same handle, where a check by the click-time ref failed
		// and published nothing (OW-lizohe). A ref with no handle is a session
		// nothing live holds, whose points nobody draws.
		const handle = handleOf(view.state, ref);
		if (handle === undefined || forkPointsInFlight.has(handle)) return;
		forkPointsInFlight.add(handle);
		void api
			.forkPoints(ref)
			.then((points) => {
				if (disposed) return;
				// Only while it is still the session on screen: a reply that lands
				// after the user clicked away describes a transcript nobody is
				// looking at, and the session they went to has its own refresh.
				if (handleOf(view.state, view.state.selected) !== handle) return;
				publish({ forkIndices: points.map((point) => point.index) });
			})
			.catch(() => {})
			.finally(() => {
				forkPointsInFlight.delete(handle);
			});
	}

	function validWorkspace(cwd: string): boolean {
		if (cwd.startsWith("/")) return true;
		publish({ error: "Workspace must be an absolute path." });
		return false;
	}

	function modelSettingForSession(ref: SessionRef | null): boolean {
		const handle = handleOf(view.state, ref);
		return handle !== undefined && pendingModelSets.has(handle);
	}

	function effortSettingForSession(ref: SessionRef | null): boolean {
		const handle = handleOf(view.state, ref);
		return handle !== undefined && pendingEffortSets.has(handle);
	}

	/** Whether the selection still names the live session `handle`. */
	function selects(handle: string): boolean {
		return handleOf(view.state, view.state.selected) === handle;
	}

	async function loadModelsForSelected(intent: number): Promise<void> {
		const selected = view.state.selected;
		if (!selected) return;
		const handle = handleOf(view.state, selected);
		if (handle === undefined || view.state.sessions[handle]?.messages.length !== 0) return;
		if (modelLoadStartedForSelection === intent) return;
		modelLoadStartedForSelection = intent;
		publish({ models: [], error: null });
		try {
			const models = await api.listModels(selected.backend);
			if (!disposed && selectionIntent === intent && selects(handle) && view.state.sessions[handle]?.messages.length === 0) {
				publish({ models });
			}
		} catch (error: unknown) {
			if (!disposed && selectionIntent === intent && selects(handle)) publish({ error: errorMessage(error) });
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
					listedOk = true;
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
	 *
	 * The one session it must not re-attach is one the user is detaching
	 * (OW-sugome). A gap dropped inside `detach`'s window -- `api.close` awaits
	 * the subprocess's disposal, and the live view goes only after that returns
	 * -- would reach `api.attach` here and spawn the subprocess again behind the
	 * user, leaving a read-only preview on screen over a session that is live on
	 * the server. Outside that window the gap is harmless: the detach has already
	 * dropped the view, so the reducer has no `seq` to compare against and asks
	 * for no recovery at all.
	 */
	async function recover({ ref, handle }: Recovery): Promise<void> {
		if (detaching.has(handle)) return;
		const inFlight = recoveries.get(handle);
		if (inFlight) return inFlight;
		const request = (async () => {
			try {
				const attached = await api.attach(ref);
				// `false` still moves the selection where it named `ref`, onto the
				// ref the attach answers (OW-yasewo). Kept under the handle
				// (OW-kimaya): `ref` is the gapped event's own, which the selection
				// already follows, so the move lands on the ref that attach reports
				// as current -- the one every later event and REST call names.
				if (!disposed) applyAttached(attached, false, ref);
			} catch {
				// Silent by design -- see the docblock above.
			}
		})();
		recoveries.set(handle, request);
		void request.finally(() => {
			if (recoveries.get(handle) === request) recoveries.delete(handle);
		});
		return request;
	}

	async function attachAndSelect(ref: SessionRef, intent: number): Promise<void> {
		publish({ busy: "attaching", error: null, models: [], forkIndices: null, modelSetting: modelSettingForSession(ref), effortSetting: effortSettingForSession(ref) });
		try {
			const attached = await api.attach(ref);
			if (!disposed && intent === selectionIntent) {
				applyAttached(attached, true, ref);
				publish({ modelSetting: modelSettingForSession(view.state.selected), effortSetting: effortSettingForSession(view.state.selected) });
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

	function scheduleReconnect(): void {
		if (disposed || fatalRetryTimer !== undefined) return;
		fatalRetryTimer = setTimeout(() => {
			fatalRetryTimer = undefined;
			if (disposed) return;
			connection?.close();
			connection = api.connect(handlers);
		}, FATAL_STREAM_RETRY_MS);
	}

	const handlers: EventHandlers = {
		onEvent(event: ServerEvent) {
			if (disposed) return;
			// Read before the publish below overwrites it: a turn ending is a
			// transition, and only the pair of values shows one (OW-roveze).
			const wasStreaming =
				event.type !== "sessions-changed" &&
				view.state.sessions[event.handle]?.isStreaming === true;
			const result = reduceServerEvent(view.state, event);
			if (result.state !== view.state) publish({ state: result.state });
			if (event.type === "snapshot" && selects(event.handle)) {
				void loadModelsForSelected(selectionIntent);
			}
			// The two moments the forkable set moves out from under the transcript
			// (OW-roveze). A turn boundary, in both directions: a turn that ends
			// adds its messages to what the backend will cut at, and a turn that
			// starts adds the prompt the composer's "Edit last message" is about
			// to point at. And a snapshot, which replaces the array wholesale --
			// the client-visible form of the adapter's `reset`, after which no
			// index held from before means anything. Only for the selected
			// session: it is the only transcript drawing Edit controls.
			if (event.type !== "sessions-changed") {
				const isStreaming = result.state.sessions[event.handle]?.isStreaming === true;
				const moved = event.type === "snapshot" || isStreaming !== wasStreaming;
				if (moved && selects(event.handle)) refreshForkPoints(event.session);
			}
			for (const recovery of result.recover) void recover(recovery);
			if (result.refreshSessions) void refreshSessions(false);
		},
		/**
		 * A re-established stream heals its transcripts and nothing else: the
		 * opening snapshots go out only for sessions with a live adapter and carry
		 * `{ messages, isStreaming, compaction, model }`, never `status`,
		 * `updatedAt`, `cwd` or `preview`. There is no `Last-Event-ID` cursor and
		 * no replay buffer either, so every `sessions-changed` that fanned out
		 * while the socket was down is simply gone -- and `status` (the sidebar's
		 * attached stripe, the header's Detach) and `updatedAt` (the whole sidebar
		 * ordering) move for no other reason than a listing. So the reconnect asks
		 * for one (D21, OW-vukoku), which generalises OW-lejahi's narrow fix: a
		 * detach performed while the stream was down used to leave the row lit as
		 * attached until the user pressed Refresh, and that was one visible case
		 * of a general loss.
		 *
		 * Not on the first open, whose listing `start()` already owns.
		 * `EventSource` fires `onopen` on the initial connect as well as on every
		 * re-establish, and `refreshInFlight` coalesces only listings that
		 * overlap, so an open landing after the startup listing resolves would
		 * list a second time for nothing.
		 *
		 * `listedOk` and not the open count, because the predicate is that a
		 * listing has *landed*: `refreshSessions` swallows its own failure and
		 * resolves, so a page that loaded while the server was away gets its
		 * first `onopen` ever when the server returns -- with an empty sidebar
		 * under a `connected` indicator, the one open where skipping the re-list
		 * costs the most.
		 *
		 * `false`: nobody asked for this listing, so it owns neither the status
		 * line nor the error slot.
		 */
		onOpen() {
			publish({ connection: "connected" });
			if (opened || !listedOk) void refreshSessions(false);
			opened = true;
		},
		/**
		 * A `fatal` disconnect is a source at `CLOSED`: the browser has stopped
		 * retrying and will never fire `onopen` again, so the re-list above -- the
		 * only thing that moves `status` and `updatedAt` -- can never run and the
		 * sidebar stays wrong until the user presses Refresh (OW-dekuri). So
		 * rebuild the connection instead of waiting on an open that cannot come.
		 * A rebuilt stream that opens fires `onOpen`, and D21's re-list there is
		 * the healing; one that closes fatally again lands back here, which is
		 * what keeps the retry going while the server is still answering wrongly.
		 *
		 * An ordinary drop reports `CONNECTING`: the browser's own retry is
		 * already under way and rebuilding would only race it.
		 */
		onDisconnect(fatal: boolean) {
			publish({ connection: "reconnecting" });
			if (fatal) scheduleReconnect();
		},
		onMalformed(error: Error) {
			publish({ error: error.message });
		},
	};

	const controller: AgentpaneController = {
		getView() {
			return view;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
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
			clearTimeout(fatalRetryTimer);
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
			if (viewOf(view.state, ref)) {
				publish({
					state: { ...view.state, selected: ref },
					preview: null,
					error: null,
					models: [],
					modelSetting: modelSettingForSession(ref),
					effortSetting: effortSettingForSession(ref),
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
			const handle = handleOf(view.state, selected);
			if (!selected || handle === undefined || pendingModelSets.has(handle) || view.state.sessions[handle]?.messages.length !== 0) return;
			pendingModelSets.add(handle);
			publish({ modelSetting: true, error: null });
			try {
				await api.setModel(selected, model);
			} catch (error: unknown) {
				if (!disposed && selects(handle)) publish({ error: errorMessage(error) });
			} finally {
				pendingModelSets.delete(handle);
				if (!disposed) publish({ modelSetting: modelSettingForSession(view.state.selected) });
			}
		},
		async setEffort(effort) {
			const selected = view.state.selected;
			const handle = handleOf(view.state, selected);
			if (!selected || handle === undefined || pendingEffortSets.has(handle) || view.state.sessions[handle]?.messages.length !== 0) return;
			pendingEffortSets.add(handle);
			publish({ effortSetting: true, error: null });
			try {
				await api.setEffort(selected, effort);
			} catch (error: unknown) {
				if (!disposed && selects(handle)) publish({ error: errorMessage(error) });
			} finally {
				pendingEffortSets.delete(handle);
				if (!disposed) publish({ effortSetting: effortSettingForSession(view.state.selected) });
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
			// The session's handle, which a rename landing while the request is in
			// flight (D9) leaves naming it, and its error, so success only clears
			// it if nothing new landed via SSE in the meantime -- cross-event
			// ordering relative to the POST response is not guaranteed (D2), so a
			// same-turn error can otherwise race in and be wiped by this same
			// submit's own success handler.
			const handle = handleOf(view.state, selected);
			const priorError = handle === undefined ? null : (view.state.sessions[handle]?.error ?? null);
			publish({ busy: "submitting", sending: true, error: null });
			try {
				await api.prompt(selected, { text });
				if (!disposed) {
					const currentError = handle === undefined ? null : (view.state.sessions[handle]?.error ?? null);
					const state = handle !== undefined && currentError === priorError ? clearSessionError(view.state, handle) : view.state;
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
		async forkAndSubmit(index, images) {
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
			// The requests below go out on the click-time ref even if a rename lands
			// meanwhile (D9), since every name a session has had resolves on the
			// server's routes (`ManagedSession.names`, D24); what this reads of the
			// session locally it reads through the handle, which the rename leaves
			// alone. The fork itself is not a rename: a Pi fork is a new session
			// under a new handle (D24, OW-suhoto).
			const handle = handleOf(view.state, selected);
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
				// Stop a running turn before forking it on Pi, and nowhere else.
				// The asymmetry is the decision, not an oversight (D15,
				// OW-bakosi): it stands only where the backend destroys the turn
				// whatever agentpane does.
				//
				// Pi is that backend. Its CLI stops the in-flight turn on a
				// mid-stream fork whether or not we abort: `isStreaming` goes
				// false and the turn settles (home server, 2026-09-15,
				// `pi 0.85.1`; `docs/MANUAL_TESTING.md` OW-gajesu, which is what
				// the 2026-08-20 `pi 0.84.2` run in OW-yudoni had not earned).
				// What the fork costs is the REST of the reply, not the bytes
				// already streamed: with the probe holding the fork until 47
				// text deltas were on the wire, the file the turn was streaming
				// into held the reply's first 447 characters (OW-sededi), where
				// the ungated run before it -- forking ~2s into a reasoning turn
				// -- had read an empty assistant entry. Either way the abort
				// does not cause the loss; it makes it deliberate and visible,
				// and the "Stop and ..." label is the only warning the user
				// gets.
				//
				// Codex's parent turn survives: a mid-stream `thread/fork` leaves
				// it running and it finishes with its whole reply durable on disk
				// -- measured, not inferred (home server, 2026-09-11, `codex-cli
				// 0.154.0`; OW-gojado). Claude's survives too now that OW-razoki
				// stopped the fork killing the parent's child, and there the abort
				// would cost most of all: nothing reaches the store file until the
				// turn is over, so a stop mid-turn destroys the entire reply rather
				// than racing it (home server, 2026-09-11, `claude 2.1.268`;
				// OW-japuzo).
				if (selected.backend === "pi" && handle !== undefined && view.state.sessions[handle]?.isStreaming) await api.abort(selected);
				if (disposed) return null;
				const points = await api.forkPoints(selected);
				if (disposed) return null;
				const point = points.find((candidate) => candidate.index === index);
				if (!point) throw new Error("That message is no longer a fork point in this session.");
				const forked = await api.fork(selected, { entryId: point.id });
				// From here the fork exists, and every exit below up to the prompt
				// abandons it: this `disposed` return, the one after the attach, and
				// the `catch` on a throw from `api.attach` or `api.prompt`. That orphan
				// is deliberate (OW-puduro): what it costs is a session file, and the
				// owner weighed that and declined to spend anything on it (OW-fejota).
				// The trap if that is ever revisited: the server's `DELETE` route
				// disposes the *adapter*, never the file, and on Pi the one live
				// adapter has MOVED onto the fork -- so a DELETE aimed at the orphan
				// is aimed at the agent the user is talking to. Only the
				// fork's own ref carries that hazard: since OW-kekoji the parent's ref
				// is not an alias for it.
				if (disposed) return null;
				// The backends reach "attached to the fork" from opposite directions,
				// and this one line covers all of them. Pi's fork moved the live
				// process onto the new file, so the manager already holds a container
				// named by the fork's ref and this attach finds it; Codex and Claude
				// Code each minted a conversation nothing is driving, and this attach
				// is what spawns it.
				// A fork is a selection change, so the intent bumps -- a preview poll
				// still in flight must not put its old transcript back over the fork.
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
				// Abandons the fork as well; see the note at `api.fork` for why that
				// is deliberate.
				if (disposed) return null;
				// The attach is one more window for a click, and it gets the same
				// answer: the attach still lands, it just does not move the user --
				// unless that click landed on the fork's own row, whose selection
				// `applyAttached` still moves onto the live session (OW-tatebi).
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
				// Reached past a successful `api.fork`, this abandons the fork too; the
				// note at that call says why that is deliberate (OW-puduro).
				if (!disposed) publish({ error: errorMessage(error) });
				return null;
			} finally {
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
			// Marked and cleared under the handle, which a rename landing while the
			// request is in flight (D9) leaves naming the session that holds the
			// mark. None before the snapshot: `setSessionCompaction` says why that
			// marks nothing.
			const handle = handleOf(view.state, selected);
			// The session reads "requesting" from the click itself rather than from
			// the server: its own "requesting" status races the POST response (D2),
			// and the composer needs the acknowledgment either way (OW-natiha).
			// Server status/snapshot events overwrite it from here on -- the request
			// resolving is admission, not completion, so nothing here clears it.
			publish({
				busy: "compacting",
				error: null,
				state: handle === undefined ? view.state : setSessionCompaction(view.state, handle, "requesting"),
			});
			try {
				await api.compact(selected);
			} catch (error: unknown) {
				if (!disposed) {
					// Failed admission, so our own optimistic mark has to go. The
					// guard reads "requesting" and cannot tell whose it is: in a
					// multi-client session it is usually another client's wire truth,
					// because the live compaction that made the backend refuse us is
					// the same one that raised it (Codex's `TURN_ACTIVE_ERROR`). We
					// clear it anyway, and it stays cleared until that compaction
					// reaches "running". Accepted, with what it costs recorded at
					// `setSessionCompaction` (OW-husivu).
					//
					// Threshold compaction is why this is narrow rather than
					// unconditional: it enters at "running", never "requesting", so
					// only a click-shaped mark is in scope here.
					const current = handle === undefined ? undefined : view.state.sessions[handle]?.compaction;
					const state = handle !== undefined && current === "requesting"
						? setSessionCompaction(view.state, handle, null)
						: view.state;
					publish({ error: errorMessage(error), state });
				}
			} finally {
				if (!disposed && view.busy === "compacting") publish({ busy: "idle" });
			}
		},
		async detach() {
			const selected = view.state.selected;
			if (!selected) return;
			// Captured rather than bumped: a detach is not a selection change, and
			// bumping would retract a preview or attach the user started before
			// clicking it. `api.close` awaits the subprocess's disposal, so the
			// window is wide enough to matter twice over -- the preview below would
			// snap the selection back off a row clicked during it, and its own bump
			// would drop an `attachAndSelect` for that row into the branch that
			// publishes no live view, leaving the client selected on a session the
			// server has already spawned. Bailing costs nothing: the re-list the
			// close broadcasts drops the dead view on its own.
			const intent = selectionIntent;
			// The live view is found through its handle, and the summary below by
			// ref: `list()` gives a summary a handle only while the server holds
			// the session, so one re-listed after the close carries none.
			const key = sessionKey(selected);
			const handle = handleOf(view.state, selected);
			publish({ error: null });
			// Held across the close and released before the view is dropped, with
			// nothing awaited in between: a gap arriving in that window must not
			// re-attach what is being closed (`recover`, OW-sugome).
			if (handle !== undefined) detaching.add(handle);
			try {
				await api.close(selected);
			} catch (error: unknown) {
				if (!disposed && intent === selectionIntent) publish({ error: errorMessage(error) });
				return;
			} finally {
				if (handle !== undefined) detaching.delete(handle);
			}
			if (disposed || intent !== selectionIntent) return;
			// Drop the live view here rather than waiting for the `sessions-changed`
			// re-list to do it through `replaceSessionSummaries`. That re-list is
			// asynchronous, and `preview` below short-circuits on a session this
			// client still has attached -- so letting the two race leaves the dead
			// view on screen whenever the preview wins.
			if (handle !== undefined && view.state.sessions[handle] !== undefined) {
				const sessions = { ...view.state.sessions };
				delete sessions[handle];
				publish({ state: { ...view.state, sessions } });
			}
			// A session with nothing on disk has nothing to preview and no row to go
			// back to: `readSessionPreview` answers its ref with an
			// empty-but-*non-null* transcript rather than an error, which is enough
			// to put `App.svelte` on its preview branch, whose one control is an
			// Attach that can only 404 on a ref the session manager no longer holds
			// (OW-vasubu). Land on the startup view instead -- selection cleared, no
			// preview -- which is where every user starts anyway. Bumping the intent
			// here is safe and makes this the last word on the selection, as
			// `preview` below would have been: the intent is unchanged, so nothing
			// the user started during the close is in flight.
			//
			// Read off the summary's `onDisk`, which is the session index's answer,
			// and not off anything that merely correlates with it. Not `status`: a
			// session this client has attached lists as `attached` whatever the
			// store holds -- the status is about the process (`session-manager.ts`,
			// `#liveOverlay`). Not the `virtual:` prefix: every backend replaces
			// that id at attach, while nothing reaches disk until the first turn
			// (D9), and a fork is born with no file and no such prefix at all
			// (OW-wedupe). Read after the close, so a re-list that landed during it
			// is the answer; a row it dropped is a session nothing lists, which is
			// this exit too. A listing that has not yet caught up with a first turn
			// errs the same way, and the re-list below brings its row back.
			const listed = view.state.summaries.find((item) => sessionKey(item.ref) === key);
			if (!listed?.onDisk) {
				// This exit asks for the listing itself, and the one below does not
				// (D21). The difference is what the stale row means. A detached stored
				// session lists with the wrong `status` -- the stripe says attached
				// when it is not -- which is merely untrue and can wait for the
				// reconnect re-list. A detached session with nothing on disk is gone
				// everywhere: no file, and dropped from the manager's table.
				// Its row nonetheless lives on in `summaries`, which is what the
				// sidebar renders, and a click on it strands the user on the
				// empty-but-non-null preview OW-vasubu exists to keep them off. So
				// the phantom is removed now rather than whenever the stream next
				// comes up. Not awaited, and `false`: nobody asked for this listing.
				void refreshSessions(false);
				++selectionIntent;
				publish({ state: { ...view.state, selected: null }, preview: null });
				return;
			}
			// A session with a transcript on disk ends where a click on its
			// now-detached row would have put the user (OW-tewave).
			await controller.preview(selected);
		},
		clearError() {
			const selected = view.state.selected;
			const handle = handleOf(view.state, selected);
			const dismissed = handle === undefined ? null : (view.state.sessions[handle]?.error ?? null);
			const state = handle === undefined ? view.state : clearSessionError(view.state, handle);
			// The server holds the session's error for every later snapshot
			// (OW-bipume), so it is told too, or the next one would put the banner
			// back -- told which error, so one newer than what was on screen
			// survives. Not awaited: the banner goes now. A failed dismissal leaves
			// the server's copy standing, and the next snapshot shows it again,
			// which is the truth about where it stands.
			if (selected && dismissed !== null) void api.dismissError(selected, dismissed).catch(() => {});
			publish({ error: null, state });
		},
	};

	return controller;
}
