import {
	ROUTES,
	type ApiError,
	type CreateSessionRequest,
	type PromptRequest,
	type ServerEvent,
	type SessionRef,
	type SessionSummary,
} from "$shared/protocol.ts";

export interface EventConnection {
	close(): void;
}

export interface EventHandlers {
	onEvent(event: ServerEvent): void;
	onOpen(): void;
	onDisconnect(): void;
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
	prompt(ref: SessionRef, body: PromptRequest): Promise<void>;
	abort(ref: SessionRef): Promise<void>;
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
				return (body as { sessions: SessionSummary[] }).sessions;
			});
		},
		createSession(body) {
			return request(
				ROUTES.sessions,
				jsonRequest(body),
				(response) => (response as { ref: SessionRef }).ref,
			);
		},
		attach(ref) {
			return request(ROUTES.session(ref), { method: "GET" }, (body) => {
				return (body as { session: SessionSummary }).session;
			});
		},
		prompt(ref, body) {
			return requestNoContent(ROUTES.prompt(ref), jsonRequest(body));
		},
		abort(ref) {
			return requestNoContent(ROUTES.abort(ref), { method: "POST" });
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
		try {
			handlers.onEvent(JSON.parse(event.data) as ServerEvent);
		} catch (error: unknown) {
			handlers.onMalformed(error instanceof Error ? error : new Error(String(error)));
		}
	};
	source.onopen = () => handlers.onOpen();
	source.onerror = () => handlers.onDisconnect();
	return {
		close() {
			source.close();
		},
	};
}
