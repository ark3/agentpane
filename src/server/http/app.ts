/**
 * The HTTP surface: one SSE stream for server->browser, plain REST for
 * everything else (D2). `src/shared/protocol.ts` is the contract; this file
 * implements exactly it and invents nothing that is not there.
 *
 * `createApp` returns a bare `fetch(Request) => Response` handler with no
 * runtime coupling, so the whole transport is exercisable in-process by tests
 * that never open a socket. `src/server/index.ts` is the thin Bun binding.
 *
 * Ordering across the two channels is not guaranteed and nothing here assumes
 * it: a prompt POST answers as soon as the turn is *accepted*, and the turn's
 * events may well have reached the browser first.
 */

import {
	type AgentRequestReply,
	type ApiError,
	type AttachSessionResponse,
	type BackendId,
	type CreateSessionRequest,
	type CreateSessionResponse,
	type ForkRequest,
	type ForkResponse,
	type ForkPointsResponse,
	type ListSessionsResponse,
	type ModelsResponse,
	type PromptRequest,
	type SessionPreviewResponse,
	type SessionRef,
	type SessionSummary,
	type SetModelRequest,
	sessionKey,
} from "../../shared/protocol.ts";
import type { BackendAdapter } from "../adapters/types.ts";
import { Broadcaster, type SseClient } from "./broadcaster.ts";
import type { AppDeps } from "./deps.ts";
import { SessionManager, UnknownBackendError, UnknownSessionError } from "./session-manager.ts";

export interface App {
	fetch(request: Request): Promise<Response>;
	readonly sessions: SessionManager;
	readonly broadcaster: Broadcaster;
	/** Drop every stream and dispose every adapter. Server shutdown only. */
	close(): Promise<void>;
}

const BACKENDS: readonly BackendId[] = ["pi", "codex"];

export function createApp(deps: AppDeps): App {
	const broadcaster = new Broadcaster(deps.heartbeatMs ?? 0);
	const sessions = new SessionManager(deps, broadcaster);

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const segments = url.pathname.split("/").filter((s) => s.length > 0).map(decodeSegment);

		if (segments[0] !== "api") {
			const served = await deps.staticHandler?.(request);
			return served ?? notFound(url.pathname);
		}

		if (!isLoopbackOrigin(request.headers.get("origin"))) {
			return error(403, "forbidden_origin", "this API is reachable only from a local page");
		}

		// /api/events
		if (segments.length === 2 && segments[1] === "events") {
			if (request.method !== "GET") return methodNotAllowed(request.method, "GET");
			return openEventStream(request);
		}

		// /api/models
		if (segments.length === 2 && segments[1] === "models") {
			if (request.method !== "GET") return methodNotAllowed(request.method, "GET");
			return listModels(url.searchParams.get("backend"));
		}

		// /api/requests/:requestId
		if (segments.length === 3 && segments[1] === "requests") {
			if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
			return replyToRequest(request, segments[2] as string);
		}

		if (segments[1] === "sessions") {
			// /api/sessions
			if (segments.length === 2) {
				if (request.method === "GET") return listSessions(url.searchParams.get("cwd"));
				if (request.method === "POST") return createSession(request);
				return methodNotAllowed(request.method, "GET, POST");
			}

			// /api/sessions/:backend/:id[/action]
			if (segments.length === 4 || segments.length === 5) {
				const backend = segments[2] as string;
				const id = segments[3] as string;
				if (!isBackendId(backend)) {
					return error(400, "bad_backend", `unknown backend "${backend}"`);
				}
				const ref: SessionRef = { backend, id };
				return segments.length === 4
					? sessionRoute(request, ref)
					: sessionAction(request, ref, segments[4] as string);
			}
		}

		return notFound(url.pathname);
	}

	// -- SSE -----------------------------------------------------------------

	function openEventStream(request: Request): Response {
		let client: SseClient | undefined;
		const encoder = new TextEncoder();

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				client = broadcaster.addClient(
					(chunk) => controller.enqueue(encoder.encode(chunk)),
					() => {
						try {
							controller.close();
						} catch {
							// Already closed by the other side; nothing to do.
						}
					},
				);
				// Attach and reconnect are the same thing (D3): the client's first
				// events are a full snapshot of everything currently live. There is
				// no resume protocol and deliberately no Last-Event-ID handling.
				broadcaster.sendOpeningSnapshots(client, sessions.liveRefs());
			},
			cancel() {
				// The browser went away. This is NOT a lifecycle event -- the
				// subprocess is tied to the server, not to this stream.
				client?.close();
			},
		});

		request.signal?.addEventListener("abort", () => client?.close());

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				// Not proxied in practice, but harmless and saves a debugging hour
				// if anyone ever puts one in front.
				"x-accel-buffering": "no",
			},
		});
	}

	// -- sessions ------------------------------------------------------------

	async function listSessions(cwd: string | null): Promise<Response> {
		const body: ListSessionsResponse = {
			sessions: await sessions.list(cwd ? { cwd } : undefined),
		};
		return json(body);
	}

	async function createSession(request: Request): Promise<Response> {
		const body = await readJson<CreateSessionRequest>(request);
		if (!body.ok) return body.response;
		const { cwd, backend, model } = body.value;
		if (typeof cwd !== "string" || cwd.length === 0) {
			return error(400, "bad_request", "cwd is required and must be an absolute path");
		}
		if (!isBackendId(backend)) return error(400, "bad_backend", `unknown backend "${backend}"`);
		const ref = sessions.createVirtual(cwd, backend, model);
		const response: CreateSessionResponse = { ref };
		return json(response, 201);
	}

	async function sessionRoute(request: Request, ref: SessionRef): Promise<Response> {
		// GET is "open this session": spawn if needed, then everyone gets a
		// snapshot over SSE. DELETE is the one thing that kills an agent.
		if (request.method === "GET") {
			await sessions.attach(ref);
			// `summary.ref` is authoritative and may differ from the URL: attaching
			// is one of the two points at which a session adopts its backend's own
			// id (D9). Clients also hear about it as a `renamed` SSE event.
			const summary = sessions.summaryOf(ref);
			if (!summary) return error(404, "not_found", `no such session: ${sessionKey(ref)}`);
			const body: AttachSessionResponse = { session: summary };
			return json(body);
		}
		if (request.method === "DELETE") {
			await sessions.close(ref);
			return noContent();
		}
		return methodNotAllowed(request.method, "GET, DELETE");
	}

	async function sessionAction(
		request: Request,
		ref: SessionRef,
		action: string,
	): Promise<Response> {
		switch (action) {
			case "preview": {
				// Read-only, non-attaching (OW-38). This deliberately never touches
				// `sessions` (the process table): selecting a session to look at must
				// not spawn one, and must not re-walk the corpus (D9). It reads the
				// one stored file for this ref through the index seam and returns its
				// flattened text turns. The attach-on-GET route is left untouched.
				if (request.method !== "GET") return methodNotAllowed(request.method, "GET");
				const turns = await deps.index.preview(ref);
				const response: SessionPreviewResponse = { ref, turns };
				return json(response);
			}
			case "prompt": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const body = await readJson<PromptRequest>(request);
				if (!body.ok) return body.response;
				if (typeof body.value.text !== "string") {
					return error(400, "bad_request", "text is required");
				}
				await sessions.attach(ref);
				// Through the manager, not straight at the adapter: `submit()` is
				// one of the two points at which a session's id changes under us
				// (D9), and the manager is what re-keys the process table.
				//
				// Both production adapters resolve submit() once the backend has
				// admitted the turn, not when the turn completes. Await that boundary
				// before acknowledging the POST so a rejected admission remains a
				// normal HTTP failure and the browser can preserve its draft.
				await sessions.submit(ref, body.value.text, body.value.images);
				return accepted();
			}
			case "abort": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const adapter = requireAttached(ref);
				await adapter.abort();
				return noContent();
			}
			case "compact": {
				// Like abort, this acts on a session already attached -- compaction
				// only makes sense against a live context. The adapter's reducer is
				// what turns the backend's compaction events into the transcript
				// marker; this route just admits the request (OW-72).
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const adapter = requireAttached(ref);
				await adapter.compact();
				return noContent();
			}
			case "fork": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const body = await readJson<ForkRequest>(request);
				if (!body.ok) return body.response;
				if (typeof body.value.entryId !== "string") {
					return error(400, "bad_request", "entryId is required");
				}
				// Attach first so the session has a live adapter, then fork through
				// the manager (not straight at the adapter): fork is the third point
				// at which a session's id can change under us, and the manager is what
				// re-keys the process table (see SessionManager.fork).
				await sessions.attach(ref);
				const forked = await sessions.fork(ref, body.value.entryId);
				// The two backends' forks are asymmetric, settled live (see
				// docs/HANDOFF.md and docs/MANUAL_TESTING.md, OW-pifowo/OW-22):
				//   * Pi's `fork` is copy-on-write. The same process's active
				//     `sessionFile` MOVES to a new file (the old branch survives on
				//     disk byte-identical), so `sessions.fork` re-keys the table and
				//     broadcasts `renamed` + a snapshot through `#adoptRef`. The ref
				//     it returns is the moved file.
				//   * Codex's `thread/fork` mints a NEW thread this process is not
				//     driving; Codex flushes that rollout to disk immediately, before
				//     any turn, so a fresh attach on the returned ref finds it. The
				//     current adapter's own ref is unchanged, so `#adoptRef` no-ops.
				// `#adoptRef` already emits `sessionsChanged` when it re-keys (Pi), so
				// no explicit broadcast here.
				const response: ForkResponse = { ref: forked };
				return json(response, 201);
			}
			case "fork-points": {
				if (request.method !== "GET") return methodNotAllowed(request.method, "GET");
				const adapter = await sessions.attach(ref);
				const response: ForkPointsResponse = { points: await adapter.listForkPoints() };
				return json(response);
			}
			case "model": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const body = await readJson<SetModelRequest>(request);
				if (!body.ok) return body.response;
				if (typeof body.value.model !== "string") {
					return error(400, "bad_request", "model is required");
				}
				const adapter = await sessions.attach(ref);
				await adapter.setModel(body.value.model);
				return noContent();
			}
			default:
				return notFound(`/api/sessions/${ref.backend}/.../${action}`);
		}
	}

	function requireAttached(ref: SessionRef): BackendAdapter {
		const adapter = sessions.adapterFor(ref);
		if (!adapter) throw new UnknownSessionError(ref);
		return adapter;
	}

	// -- models --------------------------------------------------------------

	async function listModels(backend: string | null): Promise<Response> {
		if (backend !== null && !isBackendId(backend)) {
			return error(400, "bad_backend", `unknown backend "${backend}"`);
		}
		const wanted = backend ? [backend] : BACKENDS;
		const models: ModelsResponse["models"] = [];
		for (const id of wanted) {
			const factory = deps.adapters[id];
			if (!factory) continue;
			// Prefer a live adapter -- a running agent can answer authoritatively.
			// Otherwise ask an unstarted one: model lists are a property of the
			// backend, not of a session, but `listModels` only exists on an adapter
			// instance. Construction is contractually side-effect-free, so this
			// spawns nothing.
			//
			// Known limitation, verified against the real `PiAdapter`: asking one
			// that has not been started rejects with "Pi process is not running",
			// so with no Pi session open this route reports zero Pi models rather
			// than the real list. It degrades quietly and it is not a crash, but a
			// model picker cannot be built on it alone -- see DESIGN's open
			// questions. Spawning to answer a *listing* question is exactly what
			// D9 rules out.
			const live = sessions
				.liveRefs()
				.filter((ref) => ref.backend === id)
				.map((ref) => sessions.adapterFor(ref))
				.find((adapter) => adapter !== undefined);
			let adapter: BackendAdapter;
			try {
				adapter = live ?? factory.create({ backend: id, id: "" });
			} catch {
				// A factory that will not construct without a real id is still not
				// grounds for failing the other backend's list.
				continue;
			}
			try {
				models.push(...(await adapter.listModels()));
			} catch {
				// Ditto for a backend that cannot enumerate without a subprocess.
			} finally {
				if (!live) await Promise.resolve(adapter.dispose()).catch(() => {});
			}
		}
		const body: ModelsResponse = { models };
		return json(body);
	}

	// -- server-initiated requests (D2a) -------------------------------------

	async function replyToRequest(request: Request, requestId: string): Promise<Response> {
		const body = await readJson<AgentRequestReply>(request);
		if (!body.ok) return body.response;
		if (body.value.requestId !== undefined && body.value.requestId !== requestId) {
			return error(400, "bad_request", "requestId in body does not match the route");
		}
		const ref = sessions.sessionOfRequest(requestId);
		if (!ref) {
			// Either already answered or never ours. Worth distinguishing from a
			// bad route: an unanswered request hangs the agent's turn, so a client
			// that gets this should stop waiting rather than retry forever.
			return error(404, "unknown_request", `no pending request ${requestId}`);
		}
		const adapter = sessions.adapterFor(ref);
		if (!adapter) return error(409, "not_attached", `session ${sessionKey(ref)} is no longer running`);
		await adapter.reply(requestId, body.value.response ?? null);
		sessions.clearRequest(requestId);
		return noContent();
	}

	return {
		async fetch(request: Request): Promise<Response> {
			try {
				return await handle(request);
			} catch (err) {
				if (err instanceof UnknownSessionError) return error(404, "not_found", err.message);
				if (err instanceof UnknownBackendError) return error(501, "no_backend", err.message);
				return error(500, "internal_error", describe(err));
			}
		},
		sessions,
		broadcaster,
		async close() {
			broadcaster.closeAll();
			await sessions.disposeAll();
		},
	};
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		// A malformed escape is not a path we have -- let it 404 as itself.
		return segment;
	}
}

function isBackendId(value: unknown): value is BackendId {
	return value === "pi" || value === "codex";
}

/**
 * D8 binds 127.0.0.1 so nothing off this machine can reach us. That closes the
 * network, not the browser: any page in any tab can issue cross-origin requests
 * to a loopback port, and a `POST` with a simple content type is not preflighted
 * — so `evil.com` cannot *read* our replies, but it can drive them. Every route
 * behind here spawns sandboxed agents with write access to the user's
 * repositories, which makes a blind write plenty.
 *
 * D8's reasoning ("no auth needs to exist once remote access is off the table")
 * is about remote *network* access and does not extend to this, so it is not
 * being overturned here. pipane has no origin check either (HANDOFF finding
 * 17), which is where the gap was inherited from.
 *
 * The rule is loopback-*origin*, not same-origin: in dev the page is served by
 * Vite on another port and proxied here, so an exact match would reject the
 * only client we have. A request with no `Origin` at all is curl, or a typed
 * URL — not something a page can forge, since browsers always attach it
 * cross-origin.
 */
function isLoopbackOrigin(origin: string | null): boolean {
	if (origin === null) return true;
	let hostname: string;
	try {
		({ hostname } = new URL(origin));
	} catch {
		// Includes the literal `"null"` an opaque origin sends -- a sandboxed
		// iframe or a `data:` document. Not a URL, and never ours.
		return false;
	}
	// Anchored, because `127.0.0.0/8` is all loopback but `startsWith("127.")`
	// also accepts `127.0.0.1.evil.example`, which is a name someone else owns.
	// Caught by the test above, not by reading this back.
	return (
		hostname === "localhost" ||
		hostname === "[::1]" ||
		hostname === "::1" ||
		/^127(\.\d{1,3}){3}$/.test(hostname)
	);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function noContent(): Response {
	return new Response(null, { status: 204 });
}

/** The prompt route: the turn is accepted, its events come over SSE. */
function accepted(): Response {
	return new Response(null, { status: 202 });
}

function error(status: number, code: string, detail?: string): Response {
	const body: ApiError = detail === undefined ? { error: code } : { error: code, detail };
	return json(body, status);
}

function notFound(path: string): Response {
	return error(404, "not_found", `no route for ${path}`);
}

function methodNotAllowed(method: string, allow: string): Response {
	const response = error(405, "method_not_allowed", `${method} not allowed; try ${allow}`);
	response.headers.set("allow", allow);
	return response;
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; response: Response };

async function readJson<T>(request: Request): Promise<ReadResult<T>> {
	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		return { ok: false, response: error(400, "bad_json", "request body is not valid JSON") };
	}
	if (parsed === null || typeof parsed !== "object") {
		return { ok: false, response: error(400, "bad_json", "request body must be a JSON object") };
	}
	return { ok: true, value: parsed as T };
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
