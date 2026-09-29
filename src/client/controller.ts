import type {
	BackendId,
	LiveSessionSummary,
	ModelInfo,
	PromptRequest,
	ServerEvent,
	SessionPreviewResponse,
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
	 * Read-only transcript of the selected session (OW-39), as last read from
	 * its store. Whether the pane shows it is `paneMode`'s to say, not this
	 * field's: its absence does not mean the session is live (OW-forinu).
	 *
	 * Kept only while it is what the pane shows. `publish` drops it once the tab
	 * holds a live view of the selection or the selection leaves its ref, so a
	 * view dropped later lands on the detached-loading pane and a fresh read,
	 * never on this stale one, and the poll never re-reads a transcript nobody
	 * is looking at.
	 */
	preview: { ref: SessionRef; turns: SessionPreviewTurn[] } | null;
	/**
	 * Why the last read of the selected session's preview failed, which the
	 * detached-loading pane shows above its Attach button (OW-bilogo). Only
	 * `loadPreview` writes it, and only for a read that failed with the stream
	 * up. Never the error slot: no gesture stands behind that read.
	 *
	 * It belongs to that session's loading pane, so `publish` drops it once the
	 * pane leaves that mode -- a read succeeding, a snapshot -- or the selection
	 * leaves the session.
	 */
	previewFailure: { ref: SessionRef; message: string } | null;
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

export type PaneMode = "live" | "preview" | "loading";

/**
 * What the pane shows for the selected session, derived by a fixed precedence
 * from what this tab holds for it and never stored (D25, OW-forinu):
 *
 *  - `live` while the tab holds a live view of it: the transcript and the
 *    composer, and only here. A stored preview is ignored.
 *  - `preview` while it holds no view and a preview of that session is
 *    stored: the read-only transcript and the Attach button.
 *  - `loading` while it holds neither: the Attach button over an empty pane,
 *    which the owner chose on 2026-09-28 over keeping the last live transcript
 *    on screen, because it says honestly that something is going on.
 *    `publish` fetches the preview that moves it on.
 *
 * Null with nothing selected, which is none of the three: the startup view,
 * whose composer answers a Send by asking for a selection.
 *
 * `App.svelte` draws from this and the controller's live verbs act only on
 * `live`, so nothing sends without a view whatever the UI draws. The pane used
 * to read "live" off the preview's absence, and every path that adds or drops
 * a view kept the two paired by hand; three of them slipped, leaving a
 * composer over no view (OW-zivamo, OW-wazija, OW-tefigi) or a preview over a
 * live one (OW-tefigi).
 *
 * An attach reply can beat its own snapshot (D2), and that window is not
 * `live` either: nothing in the state tells it from a view a gap dropped, so
 * the Attach button stands until the snapshot lands -- over the preview the
 * user attached from, if one is stored, and otherwise over an empty pane,
 * whose preview `publish` may fetch meanwhile. Accepted at filing: the
 * server broadcasts an attach's snapshot before it replies, so the window is
 * the reordering D2 allows and usually nothing.
 */
export function paneMode(view: Pick<ControllerView, "state" | "preview">): PaneMode | null {
	const selected = view.state.selected;
	if (selected === null) return null;
	if (viewOf(view.state, selected) !== undefined) return "live";
	if (view.preview !== null && sessionKey(view.preview.ref) === sessionKey(selected)) return "preview";
	return "loading";
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
	 * below does, because there are four ways for it not to -- nothing
	 * selected, a selection this tab holds no live view of (OW-forinu), an
	 * empty draft or a prompt already in flight, and a rejected POST -- and the
	 * caller arms per-tab state on a submit that only the answer here can tell
	 * it to take back down (OW-mifuki).
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
	 * Resolves to **the attach reply of the session the prompt landed on**, or
	 * null if it never landed. Not a boolean, because the caller has per-tab
	 * state keyed on the session it armed before the fork -- scroll, follow, the
	 * badge -- and has to move it onto the fork; reading `state.selected` back
	 * instead would move it onto whatever the user clicked mid-fork (OW-mifuki).
	 * And carrying the fork's handle, not only its ref, because the fork's first
	 * prompt can rename it before this resolves -- Claude Code renames at `init`,
	 * after `submit()` -- and by then no view or summary carries the ref the
	 * attach replied with, so a lookup by it finds nothing (OW-kimaya).
	 *
	 * Null means a genuine failure -- nothing selected, a selection this tab
	 * holds no live view of (OW-forinu), an empty draft, a press on top of one
	 * still in flight, no fork point at that index, or a rejected request.
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
	forkAndSubmit(index: number, images?: PromptRequest["images"]): Promise<LiveSessionSummary | null>;
	/** Stop the selected session's turn; no-op unless its pane is live (OW-forinu). */
	abort(): Promise<void>;
	/** Compact the selected session's context (OW-72); no-op unless its pane is live (OW-forinu). */
	compact(): Promise<void>;
	/**
	 * End the selected session's subprocess and leave the user on its read-only
	 * preview (OW-tewave), which is where a click on that row would have put
	 * them: the pane reads detached, and `publish` fetches the preview
	 * (OW-forinu). No-op with nothing selected.
	 *
	 * Not held to a live pane, as the other session verbs are: after a gap the
	 * server still holds the session with no view in this tab, and a detach is
	 * still the way to close it. The browser offers Detach only in the composer,
	 * so only on a live pane, today.
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
 * How long `loadPreview` lets a preview read run before aborting it
 * (OW-bilogo), which then counts as a failed read. A first cut nothing has
 * measured: the server answers it from local disk, so ten seconds is far past
 * any answer it would give.
 */
const PREVIEW_READ_TIMEOUT_MS = 10_000;

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
		previewFailure: null,
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
	/** The one listing owed to callers that arrived while `refreshInFlight` was out -- see `refreshSessions`. */
	let refreshOwed: Promise<void> | undefined;
	/** Whether the owed listing surfaces: a press joined it. */
	let owedSurfacing = false;
	/** Whether the event stream has ever been up: every open after the first is a reconnect. */
	let opened = false;
	/** Whether any listing has ever landed. `refreshSessions` swallows its failures, so success is not the default. */
	let listedOk = false;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let pollDelay = PREVIEW_POLL_IDLE_MS;
	const forkPointsInFlight = new Set<string>();
	/** Sessions, by ref key, whose preview `loadPreview` has out. */
	const previewLoads = new Set<string>();
	/** Whether the `previewFailure` on the view holds `loadPreview` back until the next `connected`. */
	let previewHeld = false;
	const listeners = new Set<(next: ControllerView) => void>();

	/**
	 * The controller's one chokepoint, so the pane's mode is settled here and
	 * no path that adds or drops a view can forget it (OW-forinu): a stored
	 * preview the mode no longer shows is dropped before anyone sees it, and so
	 * is a preview failure no longer on its loading pane (OW-bilogo), and a
	 * detached-loading pane gets its preview fetched.
	 */
	function publish(next: Partial<ControllerView>): void {
		if (disposed) return;
		view = { ...view, ...next };
		const mode = paneMode(view);
		if (view.preview !== null && mode !== "preview") view = { ...view, preview: null };
		const failure = view.previewFailure;
		if (failure !== null && (mode !== "loading" || sessionKey(view.state.selected!) !== sessionKey(failure.ref))) {
			view = { ...view, previewFailure: null };
			previewHeld = false;
		}
		for (const listener of listeners) listener(view);
		if (mode === "loading") loadPreview();
	}

	/**
	 * The one place that fetches the preview a detached-loading pane waits on
	 * (OW-forinu): whenever the pane is in that mode, the stream is up, and no
	 * fetch for that ref is already out. It replaced a fetch at each path that
	 * dropped a view -- `detachGapped`'s and `detach()`'s -- and it waits out a
	 * server that is down, which is why a stream drop can keep the selection
	 * where it used to clear it: the drop's own `publish` finds the stream
	 * `reconnecting`, and the reconnect's `connected` is the publish that fetches.
	 *
	 * No gesture stands behind it, so like the drop it writes neither `busy` nor
	 * `error` nor the selection intent. Its preview lands only if the selection
	 * still names that session and the pane there is still loading: a click
	 * elsewhere has moved on, and a view that came back meanwhile outranks it.
	 *
	 * A failed read is never an answer (OW-bilogo): the pane stays loading and
	 * the selection stands. A failure cannot be told from the outage that
	 * caused it -- the read can fail as the server exits, before the tab hears
	 * the stream drop -- and an attach whose reply beats its snapshot (D2) has
	 * its selection to keep whatever the read found, since the snapshot makes
	 * the pane live when it lands.
	 *
	 * What keeps a server answering errors from a hot loop is when the read is
	 * asked again: at the next `connected`, which releases `previewHeld`, or
	 * when the user clicks the row, whose `preview()` reads it itself -- never
	 * from the failure, and never from the publishes that merely find the pane
	 * still loading. A failure with the stream down needs no hold, as nothing
	 * asks until `connected`; with it up, it holds and puts its message on the
	 * pane, which the empty pane would otherwise hide from a user who has a
	 * server to ask.
	 *
	 * A read that has not settled within `PREVIEW_READ_TIMEOUT_MS` is aborted
	 * and counts as failed: one that hung would keep its key in `previewLoads`
	 * for good, and nothing would ever ask for that session's preview again.
	 */
	function loadPreview(): void {
		const selected = view.state.selected;
		if (selected === null || view.connection !== "connected" || previewHeld || paneMode(view) !== "loading") return;
		const key = sessionKey(selected);
		if (previewLoads.has(key)) return;
		previewLoads.add(key);
		const abort = new AbortController();
		const timeout = setTimeout(
			() => abort.abort(new Error(`No answer within ${PREVIEW_READ_TIMEOUT_MS / 1000}s.`)),
			PREVIEW_READ_TIMEOUT_MS,
		);
		const loading = () =>
			!disposed && view.state.selected !== null && sessionKey(view.state.selected) === key && paneMode(view) === "loading";
		api.preview(selected, abort.signal).then(
			(response) => {
				clearTimeout(timeout);
				previewLoads.delete(key);
				if (loading()) openPreview({ ref: selected, turns: response.turns });
			},
			(error: unknown) => {
				clearTimeout(timeout);
				previewLoads.delete(key);
				if (!loading() || view.connection !== "connected") return;
				previewHeld = true;
				publish({ previewFailure: { ref: selected, message: errorMessage(error) } });
			},
		);
	}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function busyIs(value: ControllerView["busy"]): boolean {
		return view.busy === value;
	}

	/**
	 * Put an attach reply's summary in the sidebar, in place of the row it
	 * attached, keeping that row's `status` (OW-wazija). The listing owns
	 * `status`, as it does for every other row: a reply that lands after the
	 * stream dropped describes an agent the tab takes to be gone (D25 point 3),
	 * and writing its `attached` lit the row until the reconnect's listing. A row
	 * no listing has named yet -- a session created or forked here -- reads
	 * `detached` until one does, which claims nothing; the attach broadcasts
	 * `sessions-changed` before it replies, so that listing is already on its way.
	 *
	 * Only `status` is kept. The rest of the reply stands, `handle` above all:
	 * `handleOf` falls back to it in the window before the snapshot, and
	 * `followRef` pairs a snapshot that renamed the session through it.
	 */
	function replaceSummary(summary: SessionSummary, requested: SessionRef): ClientState {
		const replaced = (item: SessionSummary) =>
			sessionKey(item.ref) === sessionKey(summary.ref) || sessionKey(item.ref) === sessionKey(requested);
		const listed = view.state.summaries.find((item) => sessionKey(item.ref) === sessionKey(summary.ref)) ??
			view.state.summaries.find((item) => sessionKey(item.ref) === sessionKey(requested));
		const summaries = view.state.summaries.filter((item) => !replaced(item));
		return { ...view.state, summaries: [...summaries, { ...summary, status: listed?.status ?? "detached" }] };
	}

	function applyAttached(summary: SessionSummary, select: boolean, requested: SessionRef): void {
		// By ref, not by handle: the ref asked for may have none yet -- a fork's
		// has none until this reply puts the summary carrying it in place
		// (OW-kimaya). The one `select: false` caller says why it keeps it.
		const takesSelection = select ||
			(view.state.selected !== null && sessionKey(view.state.selected) === sessionKey(requested));
		const selected = takesSelection ? summary.ref : view.state.selected;
		// The error slot is gated on `select`, because the caller that passes
		// `false` has no standing over it: a `forkAndSubmit` the user has clicked
		// away from, which under D17 still lands its prompt but owns neither the
		// error slot nor the preview of the session they went to (OW-miyemo).
		//
		// The selection may land on a session this tab holds no view of -- the
		// snapshot is still to come (D2), or a gap or a drop took it -- and the
		// pane then reads detached, whatever preview stands (`paneMode`).
		publish({
			state: { ...replaceSummary(summary, requested), selected },
			...(select ? { error: null } : {}),
		});
		// Only where the transcript is about to be drawn with Edit controls on it
		// (OW-roveze).
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
	//
	// A call that arrives while a listing is out is owed a fresh one, and does
	// not join the answer already coming (OW-sabova). That answer may have been
	// given before the change the call is about: the attach whose broadcast
	// arrives mid-listing, a turn boundary's broadcast (OW-furinu), another
	// client's close. Joining it left the row wherever the older answer put it
	// -- and since the listing is the only writer of a row's `status`
	// (OW-wazija), an attach made under a listing in flight read `detached` on
	// a live pane, stripe off and Detach disabled, until some later listing.
	// So the listing in flight runs out, and then exactly one more is asked,
	// whose landing is what every caller that arrived meanwhile waits on. At
	// most one is out and one owed however many broadcasts arrive, so a burst
	// costs one extra listing and cannot pile requests up.
	//
	// A press that arrives meanwhile owns what a joining press owned before
	// OW-sabova, and no more: the owed listing's failure, which it reports,
	// and its idle, if `busy` still reads `"listing"`; silence is only for the
	// listings nobody asked for. Without that, a Refresh during a broadcast
	// re-list -- likely, since turns broadcast -- would report nothing at all
	// when its listing fails. It does not get the owed listing's start: that
	// comes after the press, possibly after a gesture made in between, and a
	// `busy: "listing", error: null` there would wipe an attach's unread error
	// or write over its `"attaching"` -- the clobbering the paragraph above
	// forbids. Only a press that asks a listing itself announces it.
	//
	// The owed listing refreshes the preview on screen too, as every listing
	// does (OW-76): a press waiting on it expects the transcript to move with
	// the sidebar, and the read the listing in flight started is exactly as old
	// as that listing's answer.
	function refreshSessions(surface: boolean): Promise<void> {
		// The owed listing is checked first: between the listing in flight
		// landing and the owed one being asked, `refreshInFlight` may already be
		// clear, and a caller there still wants the owed answer, not a third.
		if (refreshOwed === undefined && refreshInFlight === undefined) return listSessions(surface);
		if (surface) owedSurfacing = true;
		if (refreshOwed === undefined) {
			const askOwed = (): Promise<void> => {
				refreshOwed = undefined;
				const owedSurfaces = owedSurfacing;
				owedSurfacing = false;
				return disposed ? Promise.resolve() : listSessions(owedSurfaces, true);
			};
			refreshOwed = refreshInFlight!.then(askOwed, askOwed);
		}
		return refreshOwed;
	}

	/**
	 * One listing, and the preview refresh beside it; `refreshSessions` decides
	 * when one is asked. `owed` is the listing callers joined, whose start no
	 * surfacing caller announces.
	 */
	function listSessions(surface: boolean, owed = false): Promise<void> {
		const request = (async () => {
			if (surface && !owed) publish({ busy: "listing", error: null });
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
				if (!disposed && surface) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && surface && view.busy === "listing") publish({ busy: "idle" });
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
		// in the meantime, and the preview may have changed hands without a
		// gesture -- `loadPreview` writes one and bumps no intent (OW-forinu) --
		// so what is on screen now has to be the session this read was of.
		const current = view.preview;
		if (!current || sessionKey(current.ref) !== sessionKey(ref)) return false;
		// `turns.length` is the change test, decided 2026-08-18: both extractors map
		// one JSONL record to at most one turn (`pi.ts:119`, `codex.ts:192`) and a
		// JSONL only appends, so new content is always new turns -- while the last
		// turn's `timestamp` is optional (OW-71) and would compare undefined to
		// undefined forever. Nothing is published when the length is unchanged, so a
		// quiet poll costs the transcript no re-render.
		if (turns.length === current.turns.length) return false;
		// Keeps the preview's own ref rather than the response's, so the preview
		// still names the selection and `paneMode` still reads it, without touching
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
	 * when the pane leaves the preview -- a snapshot bringing a live view, or
	 * reselecting a live session -- because `pollTick` re-evaluates here on the
	 * way out and disarms itself, so the worst that leaves behind is a single
	 * wake-up that fetches nothing. One invariant in one place beats a
	 * `syncPoll()` at every publish that might have changed the mode, which is a
	 * thing to forget.
	 *
	 * It polls only while the pane's mode is the preview (OW-forinu), not while a
	 * preview is merely stored: a preview beside a live view is not on screen.
	 *
	 * A chained timeout, not `setInterval`: the delay changes on every tick, and
	 * this way a slow fetch cannot overlap the next one.
	 */
	function syncPoll(): void {
		if (disposed || paneMode(view) !== "preview" || !isVisible()) {
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
	 * Detach, in this tab alone, a session whose SSE sequence gapped
	 * (`acceptsSequence` in `session-state.ts`), which means this client dropped
	 * an event (D25 point 5). The view goes, and with it everything this tab held
	 * under the handle; the server still holds the session for every other
	 * client, so nothing is closed and its row keeps what the server listed.
	 * Nothing is attached on the client's behalf either: an attach is what
	 * spawns, and one here once re-spawned a session whose close was out
	 * (OW-sugome). The preview's Attach button is the deliberate attach.
	 *
	 * A selected session is left detached-loading, and `publish`'s preview
	 * fetch takes it from there (OW-forinu), under the gapped event's `ref`: the
	 * reducer returns on a gap before it moves anything, so where that event is
	 * the first to carry a rename the selection still names the old ref (D24),
	 * and it is moved here or the fetch would read the old one. Unlike
	 * `detach()`, this keeps a session with nothing on disk selected too: the
	 * server still holds it, so the empty preview's Attach reaches it rather
	 * than 404ing (OW-vasubu), and the poll finds the transcript once the first
	 * turn writes one.
	 *
	 * No gesture reaches here -- the only caller is `onEvent` -- so, like the
	 * stream drop's detach in `onDisconnect`, this writes neither `busy` nor
	 * `error` and does not bump the intent (OW-yasewo).
	 */
	function detachGapped({ ref, handle }: Recovery): void {
		const onScreen = selects(handle);
		const sessions = { ...view.state.sessions };
		delete sessions[handle];
		publish({ state: { ...view.state, sessions, ...(onScreen ? { selected: ref } : {}) } });
	}

	/** Put a fetched preview on screen, polling it from quiet. */
	function openPreview(response: SessionPreviewResponse, next: Partial<ControllerView> = {}): void {
		publish({
			state: { ...view.state, selected: response.ref },
			preview: { ref: response.ref, turns: response.turns },
			...next,
		});
		// A freshly opened preview starts quiet, whatever the last one settled at.
		pollDelay = PREVIEW_POLL_IDLE_MS;
		stopPoll();
		syncPoll();
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
			// A gap detaches that one session (D25 point 5); see `detachGapped`.
			for (const recovery of result.recover) detachGapped(recovery);
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
		 * re-establish, and nothing coalesces with a listing that has already
		 * landed, so an open after the startup listing resolves would list a
		 * second time. A first open that lands while the startup listing is
		 * still out lists once more after it, because every call that arrives
		 * mid-listing is owed one (OW-sabova).
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
			// The transition a held preview read waits for (`loadPreview`).
			previewHeld = false;
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
		 *
		 * Either way the tab holds nothing live from here (D25): a stream drops
		 * only when the server exits, so every view goes at once, and a drop the
		 * server survived gets back what it still holds from the reconnect's
		 * opening snapshots. A selected session with a transcript on disk stays
		 * selected, and its pane reads detached: a preview on screen stays, and a
		 * live one becomes the detached-loading pane, whose preview `publish`
		 * fetches once the reconnect reports `connected` (OW-forinu) -- or which
		 * the reconnect's opening snapshot makes live again first. The intent is
		 * not bumped: a gesture still in flight settles on its own, failing
		 * against a dead server or landing on a live one, and a bump would strand
		 * its `busy`.
		 *
		 * The rows say the same, since the sidebar's stripe and streaming dot read
		 * them until the reconnect's listing, which may be the whole outage. A
		 * row with nothing on disk went with the server, as at `detach()`'s
		 * no-disk exit, and takes the selection along if it held it: there is
		 * nothing left to preview or attach, and the preview the server would
		 * answer for its ref is an empty one whose Attach can only 404
		 * (OW-vasubu). This is where that decision lives for a drop; it reads
		 * `onDisk` and not `status`, because a row an attach reply added before
		 * any listing reads `detached` (`replaceSummary`) whatever it holds. The
		 * rest read detached and idle. Each keeps its `handle`: with its view
		 * gone, it is what pairs a reconnect's opening snapshot with the row when
		 * a rename moved the ref during the outage (`followRef`).
		 */
		onDisconnect(fatal: boolean) {
			const selected = view.state.selected;
			let kept = true;
			const summaries: SessionSummary[] = [];
			for (const summary of view.state.summaries) {
				if (summary.onDisk) summaries.push(summary.status === "detached" ? summary : { ...summary, status: "detached", isStreaming: false });
				else if (selected !== null && sessionKey(summary.ref) === sessionKey(selected)) kept = false;
			}
			publish({
				connection: "reconnecting",
				state: { summaries, sessions: {}, selected: kept ? selected : null },
			});
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
			const reselectLive = async (live: SessionRef) => {
				publish({
					state: { ...view.state, selected: live },
					error: null,
					models: [],
					modelSetting: modelSettingForSession(live),
					effortSetting: effortSettingForSession(live),
				});
				await loadModelsForSelected(intent);
			};
			if (viewOf(view.state, ref)) {
				await reselectLive(ref);
				return;
			}
			publish({ error: null });
			try {
				const response = await api.preview(ref);
				if (!disposed && intent === selectionIntent) {
					// A snapshot can introduce the session while the fetch is out --
					// the reconnect's opening snapshots trail its `connected`, which is
					// when App's auto-select asks. The pane would read live over the
					// preview anyway (`paneMode`); what reselecting it still buys is the
					// live selection's model list and pending flags, which
					// `openPreview` does not set.
					const live = viewOf(view.state, response.ref);
					if (live) {
						await reselectLive(live.ref);
						return;
					}
					openPreview(response, { error: null });
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
			// Only to a session this tab holds live (OW-forinu). The pane draws no
			// composer anywhere else, but the controller does not lean on that: a
			// session with no view here is one the server may no longer hold, and
			// the prompt route answers that with 409 `not_attached` (D25).
			if (paneMode(view) !== "live") return false;
			// One prompt at a time (OW-nasofa): a second Ctrl-Enter, or Enter then a
			// click on Send, while the POST is in flight would issue a second
			// identical prompt -- the server admits it and what the backend does
			// with it is nobody's intent. Read off `sending` rather than `busy`,
			// which an abort or an attach clears mid-POST (OW-kelede).
			if (view.sending) return false;
			if (!view.draft) return false;
			const text = view.draft;
			// The error on screen as the user sends, which is the only one
			// admitting this prompt may clear: one raised while it is on its way
			// is not one they saw (OW-jokoto).
			const handle = handleOf(view.state, selected);
			const priorErrorId = handle === undefined ? null : (view.state.sessions[handle]?.errorId ?? null);
			publish({ busy: "submitting", sending: true, error: null });
			try {
				await api.prompt(selected, { text, priorErrorId });
				if (!disposed) {
					// The request cleared the global error before starting. Leaving it
					// untouched here preserves any newer failure from concurrent work.
					// The draft clears only if it is still the text that was sent: the
					// textarea stays live through the round trip, so anything typed
					// while waiting is the next prompt, not this one (OW-nasofa).
					//
					// The session's turn error is not this reply's to clear: the server
					// owns it, and the `error-cleared` it broadcasts when it admits the
					// prompt drops it here as at every other client (OW-lohubo). A
					// clear at the reply had to guess from the error's text whether it
					// was still the one held at the send, and a new turn failing at once
					// with the same text -- its `error-cleared` and `error` both handled
					// before the reply, which D2 allows -- lost the error the server
					// still held. When the reply comes first instead, the error stays
					// up until the event, which is the server's truth all along.
					if (view.draft === text) publish({ draft: "" });
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
			// Only from a session this tab holds live, as `submit` (OW-forinu). The
			// prompt to the fork further down is not checked: the fork's snapshot
			// usually lands after that prompt goes, so it is never live by then.
			if (paneMode(view) !== "live") return null;
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
				// The fork is a conversation the user has seen no error on, so admitting
				// this clears none: one its attach's start raised stays up (OW-jokoto).
				await api.prompt(attached.ref, { text, priorErrorId: null, ...(images && images.length > 0 ? { images } : {}) });
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
				return attached;
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
			// Only a session this tab holds live, as `submit` (OW-forinu).
			if (paneMode(view) !== "live") return;
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
			// Only a session this tab holds live, as `submit` (OW-forinu).
			if (paneMode(view) !== "live") return;
			// Marked and cleared under the handle, which a rename landing while the
			// request is in flight (D9) leaves naming the session that holds the
			// mark. The pane is live, so the selection names a view and the handle
			// is its key (OW-forinu): a click before the snapshot, on a preview or
			// between an attach reply and its snapshot, was refused just above.
			const handle = handleOf(view.state, selected)!;
			// The session reads "requesting" from the click itself rather than from
			// the server: its own "requesting" status races the POST response (D2),
			// and the composer needs the acknowledgment either way (OW-natiha).
			// Server status/snapshot events overwrite it from here on -- the request
			// resolving is admission, not completion, so nothing here clears it.
			publish({
				busy: "compacting",
				error: null,
				state: setSessionCompaction(view.state, handle, "requesting"),
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
					// only a click-shaped mark is in scope here. The view itself may be
					// gone by now -- a gap, a drop or a listing can take it while the
					// request is out -- and then there is no mark left to clear.
					const current = view.state.sessions[handle]?.compaction;
					const state = current === "requesting"
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
			// window is wide enough to matter: the no-disk exit below would snap the
			// selection back off a row clicked during it. Bailing costs nothing: the
			// re-list the close broadcasts drops the dead view on its own.
			const intent = selectionIntent;
			// The live view is found through its handle, and the summary below by
			// ref: `list()` gives a summary a handle only while the server holds
			// the session, so one re-listed after the close carries none.
			const key = sessionKey(selected);
			const handle = handleOf(view.state, selected);
			publish({ error: null });
			try {
				await api.close(selected);
			} catch (error: unknown) {
				if (!disposed && intent === selectionIntent) publish({ error: errorMessage(error) });
				return;
			}
			if (disposed || intent !== selectionIntent) return;
			// Drop the live view here rather than waiting for the `sessions-changed`
			// re-list to do it through `replaceSessionSummaries`, which is
			// asynchronous: until it lands the pane would still read live.
			const sessions = { ...view.state.sessions };
			if (handle !== undefined) delete sessions[handle];
			// A session with nothing on disk has nothing to preview and no row to go
			// back to: `readSessionPreview` answers its ref with an
			// empty-but-*non-null* transcript rather than an error, which is enough
			// to put the pane on its preview, whose one control is an Attach that can
			// only 404 on a ref the session manager no longer holds (OW-vasubu). Land
			// on the startup view instead -- selection cleared -- which is where
			// every user starts anyway, and decide it before the view goes, in the
			// same publish, so the detached-loading pane in between never asks for
			// that preview. Bumping the intent here is safe and makes this the last
			// word on the selection: the intent is unchanged, so nothing the user
			// started during the close is in flight.
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
				// This exit asks for the listing itself, and the other does not
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
				publish({ state: { ...view.state, sessions, selected: null } });
				return;
			}
			// A session with a transcript on disk ends where a click on its
			// now-detached row would have put the user (OW-tewave): its pane reads
			// detached-loading, and `publish` fetches the preview (OW-forinu).
			publish({ state: { ...view.state, sessions } });
		},
		clearError() {
			const selected = view.state.selected;
			const handle = handleOf(view.state, selected);
			const dismissed = handle === undefined ? null : (view.state.sessions[handle]?.errorId ?? null);
			const state = handle === undefined ? view.state : clearSessionError(view.state, handle);
			// The server holds the session's error for every later snapshot
			// (OW-bipume), so it is told too, or the next one would put the banner
			// back -- told which error, by the id the wire named it by, so one newer
			// than what was on screen survives even when its text is the same
			// (OW-jokoto). Not awaited: the banner goes now. A snapshot the server sent
			// before the dismissal reached it shows it again, until the
			// `error-cleared` the dismissal broadcasts, which follows that snapshot
			// on the one ordered stream, takes it down (OW-jopifu). A failed
			// dismissal leaves the server's copy standing, and the next snapshot
			// shows it again, which is the truth about where it stands.
			if (selected && dismissed !== null) void api.dismissError(selected, dismissed).catch(() => {});
			publish({ error: null, state });
		},
	};

	return controller;
}
