import type { BackendId, ServerEvent, SessionRef, SessionSummary } from "$shared/protocol.ts";
import { sessionKey } from "$shared/protocol.ts";
import type { AgentpaneApi, EventConnection, EventHandlers } from "./api.ts";
import {
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
}

export interface AgentpaneController {
	getView(): ControllerView;
	subscribe(listener: (view: ControllerView) => void): () => void;
	start(): Promise<void>;
	dispose(): void;
	setDraft(text: string): void;
	setWorkspace(cwd: string): Promise<void>;
	create(cwd: string, backend: BackendId): Promise<void>;
	select(ref: SessionRef): Promise<void>;
	submit(): Promise<void>;
	abort(): Promise<void>;
}

export function createController(api: AgentpaneApi): AgentpaneController {
	let view: ControllerView = {
		state: initialClientState(),
		draft: "",
		connection: "connecting",
		busy: "idle",
		error: null,
	};
	let workspace: string | undefined;
	let connection: EventConnection | undefined;
	let disposed = false;
	let started = false;
	const refreshes = new Map<string | undefined, Promise<void>>();
	const recoveries = new Map<string, Promise<void>>();
	const listeners = new Set<(next: ControllerView) => void>();

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
		publish({ state: { ...replaceSummary(summary, requested), selected }, error: null });
	}

	function validWorkspace(cwd: string): boolean {
		if (cwd.startsWith("/")) return true;
		publish({ error: "Workspace must be an absolute path." });
		return false;
	}

	async function refreshSessions(): Promise<void> {
		const requestedWorkspace = workspace;
		const inFlight = refreshes.get(requestedWorkspace);
		if (inFlight) return inFlight;
		const request = (async () => {
			publish({ busy: "listing", error: null });
			try {
				const summaries = await api.listSessions(requestedWorkspace);
				if (!disposed && workspace === requestedWorkspace) {
					publish({ state: { ...view.state, summaries }, error: null });
				}
			} catch (error: unknown) {
				if (!disposed && workspace === requestedWorkspace) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && workspace === requestedWorkspace && view.busy === "listing") {
					publish({ busy: "idle" });
				}
			}
		})();
		refreshes.set(requestedWorkspace, request);
		void request.finally(() => {
			if (refreshes.get(requestedWorkspace) === request) refreshes.delete(requestedWorkspace);
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

	async function attachAndSelect(ref: SessionRef): Promise<void> {
		publish({ busy: "attaching", error: null });
		try {
			const attached = await api.attach(ref);
			if (!disposed) applyAttached(attached, true, ref);
		} catch (error: unknown) {
			if (!disposed) publish({ error: errorMessage(error) });
		} finally {
			if (!disposed && view.busy === "attaching") publish({ busy: "idle" });
		}
	}

	const handlers: EventHandlers = {
		onEvent(event: ServerEvent) {
			if (disposed) return;
			const result = reduceServerEvent(view.state, event);
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
		async setWorkspace(cwd) {
			if (!validWorkspace(cwd)) return;
			workspace = cwd;
			await refreshSessions();
		},
		async create(cwd, backend) {
			if (!validWorkspace(cwd)) return;
			publish({ busy: "attaching", error: null });
			try {
				const created = await api.createSession({ cwd, backend });
				if (!disposed) await attachAndSelect(created);
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
			} finally {
				if (!disposed && view.busy === "attaching") publish({ busy: "idle" });
			}
		},
		async select(ref) {
			await attachAndSelect(ref);
		},
		async submit() {
			const selected = view.state.selected;
			if (!selected) {
				publish({ error: "Select a session before submitting a prompt." });
				return;
			}
			if (!view.draft) return;
			const text = view.draft;
			publish({ busy: "submitting", error: null });
			try {
				await api.prompt(selected, { text });
				if (!disposed) publish({ draft: "", error: null });
			} catch (error: unknown) {
				if (!disposed) publish({ error: errorMessage(error) });
			} finally {
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
	};
}
