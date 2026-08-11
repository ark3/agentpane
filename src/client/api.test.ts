import { describe, expect, it, vi } from "vitest";
import type {
	ServerEvent,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";
import {
	ApiClientError,
	createAgentpaneApi,
	type EventConnection,
	type EventHandlers,
} from "./api.ts";

const ref: SessionRef = { backend: "pi", id: "/tmp/a session.jsonl" };
const summary: SessionSummary = {
	ref,
	cwd: "/work",
	preview: "hello",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:01.000Z",
	status: "detached",
	isStreaming: false,
};

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fetchRecorder(...responses: Response[]) {
	const fetch = vi.fn<typeof globalThis.fetch>();
	for (const item of responses) fetch.mockResolvedValueOnce(item);
	// Bun's Fetch has a browser-only `preconnect` property that Vitest's mock
	// does not model, but the callable part is exactly what the API consumes.
	return fetch as unknown as typeof globalThis.fetch;
}

describe("agentpane API", () => {
	it("lists sessions with an optional cwd query and unwraps the response", async () => {
		const fetch = fetchRecorder(response({ sessions: [summary] }));
		const api = createAgentpaneApi({ fetch });

		expect(await api.listSessions("/work/a b")).toEqual([summary]);
		expect(fetch).toHaveBeenCalledWith("/api/sessions?cwd=%2Fwork%2Fa%20b", { method: "GET" });
	});

	it("lists all sessions without adding a query when cwd is omitted", async () => {
		const fetch = fetchRecorder(response({ sessions: [] }));
		const api = createAgentpaneApi({ fetch });

		expect(await api.listSessions()).toEqual([]);
		expect(fetch).toHaveBeenCalledWith("/api/sessions", { method: "GET" });
	});

	it("creates a session with a JSON body and unwraps its ref", async () => {
		const fetch = fetchRecorder(response({ ref }, 201));
		const api = createAgentpaneApi({ fetch });
		const body = { cwd: "/work", backend: "pi" as const };

		expect(await api.createSession(body)).toEqual(ref);
		expect(fetch).toHaveBeenCalledWith("/api/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	});

	it("attaches a session and unwraps its summary", async () => {
		const fetch = fetchRecorder(response({ session: summary }));
		const api = createAgentpaneApi({ fetch });

		expect(await api.attach(ref)).toEqual(summary);
		expect(fetch).toHaveBeenCalledWith("/api/sessions/pi/%2Ftmp%2Fa%20session.jsonl", {
		method: "GET",
	});
	});

	it("prompts a session with a JSON body", async () => {
		const fetch = fetchRecorder(new Response(null, { status: 202 }));
		const api = createAgentpaneApi({ fetch });
		const body = { text: "hello" };

		await expect(api.prompt(ref, body)).resolves.toBeUndefined();
		expect(fetch).toHaveBeenCalledWith("/api/sessions/pi/%2Ftmp%2Fa%20session.jsonl/prompt", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	});

	it("aborts a session without a request body or content type", async () => {
		const fetch = fetchRecorder(new Response(null, { status: 204 }));
		const api = createAgentpaneApi({ fetch });

		await expect(api.abort(ref)).resolves.toBeUndefined();
		expect(fetch).toHaveBeenCalledWith("/api/sessions/pi/%2Ftmp%2Fa%20session.jsonl/abort", {
			method: "POST",
		});
	});

	it("turns a JSON API error into an ApiClientError", async () => {
		const fetch = fetchRecorder(response({ error: "not_found", detail: "missing session" }, 404));
		const api = createAgentpaneApi({ fetch });

		const error = await api.listSessions().catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ApiClientError);
		expect(error).toMatchObject({
			status: 404,
			code: "not_found",
			detail: "missing session",
		});
	});

	it("retains the HTTP status for a non-JSON API error", async () => {
		const fetch = fetchRecorder(new Response("upstream unavailable", { status: 502 }));
		const api = createAgentpaneApi({ fetch });

		const error = await api.listSessions().catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ApiClientError);
		expect(error).toMatchObject({ status: 502 });
		expect((error as Error).message).toContain("502");
	});

	it("routes valid SSE messages and lifecycle callbacks", () => {
		let connection: FakeEventConnection | undefined;
		const openEvents = vi.fn((url: string, handlers: EventHandlers) => {
			connection = new FakeEventConnection(url, handlers);
			return connection;
		});
		const api = createAgentpaneApi({ fetch: fetchRecorder(), openEvents });
		const handlers: EventHandlers = {
			onEvent: vi.fn(),
			onOpen: vi.fn(),
			onDisconnect: vi.fn(),
			onMalformed: vi.fn(),
		};

		const returned = api.connect(handlers);
		const event: ServerEvent = { type: "sessions-changed" };
		connection?.emitMessage(JSON.stringify(event));
		connection?.emitOpen();
		connection?.emitError();

		expect(openEvents).toHaveBeenCalledWith("/api/events", handlers);
		expect(handlers.onEvent).toHaveBeenCalledWith(event);
		expect(handlers.onOpen).toHaveBeenCalledOnce();
		expect(handlers.onDisconnect).toHaveBeenCalledOnce();
		expect(returned).toBe(connection);
	});

	it("reports malformed SSE JSON and close delegates to the native connection", () => {
		vi.stubGlobal("EventSource", FakeNativeEventSource);
		const api = createAgentpaneApi({ fetch: fetchRecorder() });
		const onMalformed = vi.fn();
		const connection = api.connect({
			onEvent: vi.fn(),
			onOpen: vi.fn(),
			onDisconnect: vi.fn(),
			onMalformed,
		});

		FakeNativeEventSource.instance?.emitMessage("{oops");
		connection.close();

		expect(onMalformed).toHaveBeenCalledWith(expect.any(Error));
		expect(FakeNativeEventSource.instance?.closed).toBe(true);
		vi.unstubAllGlobals();
	});
});

class FakeEventConnection implements EventConnection {
	closed = false;

	constructor(
		readonly url: string,
		private readonly handlers: EventHandlers,
	) {}

	emitMessage(data: string): void {
		this.handlers.onEvent(JSON.parse(data) as ServerEvent);
	}

	emitOpen(): void {
		this.handlers.onOpen();
	}

	emitError(): void {
		this.handlers.onDisconnect();
	}

	close(): void {
		this.closed = true;
	}
}

class FakeNativeEventSource {
	static instance: FakeNativeEventSource | undefined;
	onmessage: ((event: { data: string }) => void) | null = null;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;

	constructor(readonly url: string) {
		FakeNativeEventSource.instance = this;
	}

	emitMessage(data: string): void {
		this.onmessage?.({ data });
	}

	close(): void {
		this.closed = true;
	}
}
