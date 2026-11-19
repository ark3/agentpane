import {
	ROUTES,
	type AbortResponse,
	type ApiError,
	type AttachSessionResponse,
	type CreateSessionRequest,
	type CreateSessionResponse,
	type DismissErrorRequest,
	type EditDraftRequest,
	type EditDraftResponse,
	type ForkAndPromptRequest,
	type ForkAndPromptResponse,
	type ForkPointsResponse,
	type ForkRequest,
	type ForkResponse,
	type ListSessionsResponse,
	type ModelInfo,
	type ModelsResponse,
	type PromptRequest,
	type PromptResponse,
	type ServerEvent,
	type SetEffortRequest,
	type SetModelRequest,
	type SetNameRequest,
	type SessionPreviewResponse,
	type SessionRef,
	type LiveSessionSummary,
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
	/**
	 * The API token, read at each request and sent as its bearer; while it
	 * answers null no `authorization` header is sent. Every request carries it
	 * but the event stream's: an `EventSource` cannot set a header, and the
	 * server exempts that route.
	 */
	token?: () => string | null;
	/** Told of every 401 an API request is answered with, before that request rejects with it. */
	onUnauthorized?: () => void;
}

export class ApiClientError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	readonly detail: string | undefined;
	/** The fork a fork-and-prompt created before it failed (`ApiError.fork`, D30). */
	readonly fork: ApiError["fork"];

	constructor(status: number, code?: string, detail?: string, fork?: ApiError["fork"]) {
		super(detail ?? code ?? `HTTP ${status}`);
		this.name = "ApiClientError";
		this.status = status;
		this.code = code;
		this.detail = detail;
		this.fork = fork;
	}
}

export interface AgentpaneApi {
	listSessions(cwd?: string): Promise<SessionSummary[]>;
	createSession(body: CreateSessionRequest): Promise<SessionRef>;
	attach(ref: SessionRef): Promise<LiveSessionSummary>;
	/**
	 * Read-only, non-attaching transcript preview (OW-38): spawns nothing.
	 * `signal` aborts the read, which then rejects (OW-bilogo).
	 */
	preview(ref: SessionRef, signal?: AbortSignal): Promise<SessionPreviewResponse>;
	/**
	 * Resolves with nothing for a prompt that started a turn, or joined one,
	 * as it did before the outcome existed, so a caller or fake that ignores
	 * it is unchanged; with the body for one the backend handled without
	 * starting a turn for it, though an extension's own work may still arrive
	 * on the stream (`PromptDisposition`, OW-dulipe).
	 */
	prompt(ref: SessionRef, body: PromptRequest): Promise<PromptResponse | void>;
	editDraft(body: EditDraftRequest): Promise<EditDraftResponse>;
	/**
	 * Resolves with nothing for a stop that took nothing out of the backend's
	 * queue, as it did before there was anything to return, so a caller or fake
	 * that ignores it is unchanged; with the body for one that took out
	 * prompts steered into the turn and not yet delivered (D16, OW-wisifo).
	 */
	abort(ref: SessionRef): Promise<AbortResponse | void>;
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
	/** Name an attached session, written through to its backend (D27); the name returns in the listing. */
	setName(ref: SessionRef, name: string): Promise<void>;
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
	 * Beside them, whether a fork of the session stops a running turn (D30).
	 */
	forkPoints(ref: SessionRef): Promise<ForkPointsResponse>;
	/** Fork at `entryId`; the ref it answers with is the new conversation, and the original survives. */
	fork(ref: SessionRef, body: ForkRequest): Promise<SessionRef>;
	/**
	 * Fork at the user message `body.index` names, attach the fork and prompt
	 * it, as one server operation (D30). A refusal after the fork exists
	 * rejects with an `ApiClientError` whose `fork` names it.
	 */
	forkAndPrompt(ref: SessionRef, body: ForkAndPromptRequest): Promise<ForkAndPromptResponse>;
	/**
	 * Dismiss the session's turn error on the server, so no later snapshot
	 * brings it back (OW-bipume). `errorId` names the error dismissed, as the
	 * wire named the one shown; the server keeps a newer one (OW-jokoto).
	 */
	dismissError(ref: SessionRef, errorId: string): Promise<void>;
	connect(handlers: EventHandlers): EventConnection;
}

export function createAgentpaneApi(options: ApiOptions = {}): AgentpaneApi {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const openEvents = options.openEvents ?? defaultOpenEvents;
	const token = options.token ?? (() => null);
	const onUnauthorized = options.onUnauthorized ?? (() => {});

	/** Every request this module makes goes through here, so none goes out without the token. */
	async function send(url: string, init: RequestInit): Promise<Response> {
		const bearer = token();
		const response = await fetchImpl(
			url,
			bearer === null
				? init
				: { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${bearer}` } },
		);
		if (response.status === 401) onUnauthorized();
		return response;
	}

	async function request<T>(url: string, init: RequestInit, decode: (body: unknown) => T): Promise<T> {
		const response = await send(url, init);
		if (!isSuccessful(response.status)) throw await toApiClientError(response);
		return decode(await response.json());
	}

	async function requestNoContent(url: string, init: RequestInit): Promise<void> {
		const response = await send(url, init);
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
		preview(ref, signal) {
			return request(ROUTES.preview(ref), { method: "GET", signal }, (body) => body as SessionPreviewResponse);
		},
		async prompt(ref, body) {
			const response = await send(ROUTES.prompt(ref), jsonRequest(body));
			if (!isSuccessful(response.status)) throw await toApiClientError(response);
			// The route answers a started prompt 202 with no body, and only a
			// handled one 200 with a `PromptResponse`.
			if (response.status === 200) return (await response.json()) as PromptResponse;
		},
		editDraft(body) {
			return request(ROUTES.editDraft, jsonRequest(body), (response) => response as EditDraftResponse);
		},
		async abort(ref) {
			const response = await send(ROUTES.abort(ref), { method: "POST" });
			if (!isSuccessful(response.status)) throw await toApiClientError(response);
			// The route answers a stop that took nothing out 204 with no body, and
			// one that did 200 with an `AbortResponse`.
			if (response.status === 200) return (await response.json()) as AbortResponse;
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
		setName(ref, name) {
			const body: SetNameRequest = { name };
			return requestNoContent(ROUTES.name(ref), jsonRequest(body));
		},
		forkPoints(ref) {
			return request(ROUTES.forkPoints(ref), { method: "GET" }, (body) => body as ForkPointsResponse);
		},
		fork(ref, body) {
			return request(ROUTES.fork(ref), jsonRequest(body), (response) => (response as ForkResponse).ref);
		},
		forkAndPrompt(ref, body) {
			return request(ROUTES.forkAndPrompt(ref), jsonRequest(body), (response) => response as ForkAndPromptResponse);
		},
		dismissError(ref, errorId) {
			const body: DismissErrorRequest = { errorId };
			return requestNoContent(ROUTES.error(ref), { ...jsonRequest(body), method: "DELETE" });
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

	if (isApiError(body)) return new ApiClientError(response.status, body.error, body.detail, body.fork);
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
