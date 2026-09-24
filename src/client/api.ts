import {
	ROUTES,
	type AgentRequestReply,
	type ApiError,
	type AttachSessionResponse,
	type CreateSessionRequest,
	type CreateSessionResponse,
	type EditDraftRequest,
	type EditDraftResponse,
	type ForkPoint,
	type ForkPointsResponse,
	type ForkRequest,
	type ForkResponse,
	type ListSessionsResponse,
	type ModelInfo,
	type ModelsResponse,
	type PromptRequest,
	type ServerEvent,
	type SetEffortRequest,
	type SetModelRequest,
	type SessionPreviewResponse,
	type SessionRef,
	type SessionSummary,
} from "$shared/protocol.ts";

export interface EventConnection {
	close(): void;
}

export interface EventHandlers {
	onEvent(event: ServerEvent): void;
	onOpen(): void;
	/**
	 * `fatal` is the source having reached `CLOSED`, where the browser has given
	 * up and no `onopen` can follow; an ordinary drop reports `CONNECTING`,
	 * the browser's own retry already under way (OW-dekuri).
	 */
	onDisconnect(fatal: boolean): void;
	onMalformed(error: Error): void;
}

export interface ApiOptions {
	fetch?: typeof globalThis.fetch;
	openEvents?: (url: string, handlers: EventHandlers) => EventConnection;
}

export class ApiClientError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	readonly detail: string | undefined;

	constructor(status: number, code?: string, detail?: string) {
		super(detail ?? code ?? `HTTP ${status}`);
		this.name = "ApiClientError";
		this.status = status;
		this.code = code;
		this.detail = detail;
	}
}

export interface AgentpaneApi {
	listSessions(cwd?: string): Promise<SessionSummary[]>;
	createSession(body: CreateSessionRequest): Promise<SessionRef>;
	attach(ref: SessionRef): Promise<SessionSummary>;
	/** Read-only, non-attaching transcript preview (OW-38): spawns nothing. */
	preview(ref: SessionRef): Promise<SessionPreviewResponse>;
	prompt(ref: SessionRef, body: PromptRequest): Promise<void>;
	editDraft(body: EditDraftRequest): Promise<EditDraftResponse>;
	abort(ref: SessionRef): Promise<void>;
	compact(ref: SessionRef): Promise<void>;
	/**
	 * Kill this session's subprocess and drop it from the server's table
	 * (OW-tewave). The on-disk transcript survives, so the session comes back as
	 * `detached` in the next listing -- unless nothing had reached disk, as for
	 * a session created or forked here before its first turn, which leaves the
	 * listing altogether (`SessionSummary.onDisk`).
	 */
	close(ref: SessionRef): Promise<void>;
	listModels(backend: SessionRef["backend"]): Promise<ModelInfo[]>;
	setModel(ref: SessionRef, model: string): Promise<void>;
	setEffort(ref: SessionRef, effort: string): Promise<void>;
	/**
	 * The points a session can be forked at (OW-hezidi), each naming the
	 * transcript index of the user message it forks at (OW-roveze).
	 *
	 * Not one per user message: a backend answers with the points it can
	 * actually cut at, and Codex cuts at turn granularity, so a message added by
	 * steering a running turn gets none. Nor is position the addressing scheme
	 * any more -- `ForkPoint.index` is, and it is an index into the same array
	 * `snapshot.messages` carries. `ForkPoint.id` is the backend's own cut
	 * token (a Pi entry id, a Codex turn id, a Claude Code store-line uuid) and
	 * `PaneMessage` carries none of them, which is why the index exists.
	 */
	forkPoints(ref: SessionRef): Promise<ForkPoint[]>;
	/** Fork at `entryId`; the ref it answers with is the new conversation, and the original survives. */
	fork(ref: SessionRef, body: ForkRequest): Promise<SessionRef>;
	/**
	 * Answer a server-initiated request (D2a). The browser never calls this
	 * (OW-bijera); the Emacs helper forwards `requests/reply` through it
	 * (OW-refibu).
	 */
	reply(requestId: string, body: AgentRequestReply): Promise<void>;
	connect(handlers: EventHandlers): EventConnection;
}

export function createAgentpaneApi(options: ApiOptions = {}): AgentpaneApi {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const openEvents = options.openEvents ?? defaultOpenEvents;

	async function request<T>(url: string, init: RequestInit, decode: (body: unknown) => T): Promise<T> {
		const response = await fetchImpl(url, init);
		if (!isSuccessful(response.status)) throw await toApiClientError(response);
		return decode(await response.json());
	}

	async function requestNoContent(url: string, init: RequestInit): Promise<void> {
		const response = await fetchImpl(url, init);
		if (!isSuccessful(response.status)) throw await toApiClientError(response);
	}

	return {
		listSessions(cwd) {
			const query = cwd === undefined ? "" : `?cwd=${encodeURIComponent(cwd)}`;
			return request(`${ROUTES.sessions}${query}`, { method: "GET" }, (body) => {
				return (body as ListSessionsResponse).sessions;
			});
		},
		createSession(body) {
			return request(
				ROUTES.sessions,
				jsonRequest(body),
				(response) => (response as CreateSessionResponse).ref,
			);
		},
		attach(ref) {
			return request(ROUTES.session(ref), { method: "GET" }, (body) => {
				return (body as AttachSessionResponse).session;
			});
		},
		preview(ref) {
			return request(ROUTES.preview(ref), { method: "GET" }, (body) => body as SessionPreviewResponse);
		},
		prompt(ref, body) {
			return requestNoContent(ROUTES.prompt(ref), jsonRequest(body));
		},
		editDraft(body) {
			return request(ROUTES.editDraft, jsonRequest(body), (response) => response as EditDraftResponse);
		},
		abort(ref) {
			return requestNoContent(ROUTES.abort(ref), { method: "POST" });
		},
		compact(ref) {
			return requestNoContent(ROUTES.compact(ref), { method: "POST" });
		},
		close(ref) {
			return requestNoContent(ROUTES.session(ref), { method: "DELETE" });
		},
		listModels(backend) {
			return request(`${ROUTES.models}?backend=${encodeURIComponent(backend)}`, { method: "GET" }, (body) => {
				return (body as ModelsResponse).models;
			});
		},
		setModel(ref, model) {
			const body: SetModelRequest = { model };
			return requestNoContent(ROUTES.model(ref), jsonRequest(body));
		},
		setEffort(ref, effort) {
			const body: SetEffortRequest = { effort };
			return requestNoContent(ROUTES.effort(ref), jsonRequest(body));
		},
		forkPoints(ref) {
			return request(ROUTES.forkPoints(ref), { method: "GET" }, (body) => {
				return (body as ForkPointsResponse).points;
			});
		},
		fork(ref, body) {
			return request(ROUTES.fork(ref), jsonRequest(body), (response) => (response as ForkResponse).ref);
		},
		reply(requestId, body) {
			return requestNoContent(ROUTES.reply(requestId), jsonRequest(body));
		},
		connect(handlers) {
			return openEvents(ROUTES.events, handlers);
		},
	};
}

function jsonRequest(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

function isSuccessful(status: number): boolean {
	return status >= 200 && status < 300;
}

async function toApiClientError(response: Response): Promise<ApiClientError> {
	const text = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return new ApiClientError(response.status);
	}

	if (isApiError(body)) return new ApiClientError(response.status, body.error, body.detail);
	return new ApiClientError(response.status);
}

function isApiError(body: unknown): body is ApiError {
	if (body === null || typeof body !== "object") return false;
	const candidate = body as { error?: unknown; detail?: unknown };
	return typeof candidate.error === "string" &&
		(candidate.detail === undefined || typeof candidate.detail === "string");
}

function defaultOpenEvents(url: string, handlers: EventHandlers): EventConnection {
	const source = new EventSource(url);
	source.onmessage = (event) => {
		let parsed: ServerEvent;
		try {
			parsed = JSON.parse(event.data) as ServerEvent;
		} catch (error: unknown) {
			handlers.onMalformed(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		handlers.onEvent(parsed);
	};
	source.onopen = () => handlers.onOpen();
	source.onerror = () => handlers.onDisconnect(source.readyState === EventSource.CLOSED);
	return {
		close() {
			source.close();
		},
	};
}
