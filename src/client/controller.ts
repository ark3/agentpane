import type {
	BackendId,
	ServerEvent,
	SessionPreviewTurn,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";
import { sessionKey } from "$shared/protocol.ts";
import type { AgentpaneApi, EventConnection, EventHandlers } from "./api.ts";
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
	busy: "idle" | "listing" | "attaching" | "submitting" | "aborting";
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
	/** Dismiss the current error -- the view-level one and, if selected, the session's own. */
	clearError(): void;
}

export function createController(api: AgentpaneApi): AgentpaneController {
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
			try {
				const summaries = await api.listSessions(undefined);
				if (!disposed) publish({ state: { ...view.state, summaries }, error: null });
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && view.busy === "listing") publish({ busy: "idle" });
			}
		})();
		refreshInFlight = request;
		void request.finally(() => {
			if (refreshInFlight === request) refreshInFlight = undefined;
		});
		return request;
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
		async start() {
			if (disposed || started) return;
			started = true;
			connection = api.connect(handlers);
			await refreshSessions();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
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
		clearError() {
			const selected = view.state.selected;
			const state = selected ? clearSessionError(view.state, selected) : view.state;
			publish({ error: null, state });
		},
	};
}
