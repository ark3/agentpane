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

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
	type AbortResponse,
	type ApiError,
	type AttachSessionResponse,
	type BackendId,
	type CreateSessionRequest,
	type CreateSessionResponse,
	type DismissErrorRequest,
	type EditDraftRequest,
	type EditDraftResponse,
	type ForkAndPromptRequest,
	type ForkAndPromptResponse,
	type ForkRequest,
	type ForkResponse,
	type ForkPointsResponse,
	type ListSessionsResponse,
	type ModelsResponse,
	type PromptRequest,
	type PromptResponse,
	type SessionPreviewResponse,
	type SessionRef,
	type SessionSummary,
	type SetEffortRequest,
	type SetModelRequest,
	type SetNameRequest,
	sessionKey,
} from "../../shared/protocol.ts";
import { type BackendAdapter, BackendRefusedError } from "../adapters/types.ts";
import { Broadcaster, type SseClient } from "./broadcaster.ts";
import type { AppDeps } from "./deps.ts";
import {
	EffortNotOfferedError,
	ForkNotPromptedError,
	NotAForkPointError,
	ServerShuttingDownError,
	SessionManager,
	UnknownBackendError,
	UnknownSessionError,
} from "./session-manager.ts";

export interface App {
	fetch(request: Request): Promise<Response>;
	readonly sessions: SessionManager;
	readonly broadcaster: Broadcaster;
	/** Drop every stream and dispose every adapter. Server shutdown only. */
	close(): Promise<void>;
}

const BACKENDS: readonly BackendId[] = ["pi", "codex", "claude"];

export function createApp(deps: AppDeps): App {
	const broadcaster = new Broadcaster(deps.heartbeatMs ?? 0);
	const sessions = new SessionManager(deps, broadcaster);
	const logError = deps.logError ?? ((message: string) => console.error(message));
	const apiToken = Buffer.from(deps.apiToken, "utf8");

	async function handle(request: Request): Promise<Response> {
		// Before anything parses `request.url`, which Bun leaves relative for an
		// HTTP/1.0 request that names no host.
		if (!isLoopbackHost(request)) {
			return error(403, "forbidden_host", "this server answers only to a loopback name");
		}

		const url = new URL(request.url);
		const segments = url.pathname.split("/").filter((s) => s.length > 0).map(decodeSegment);

		if (segments[0] !== "api") {
			const served = await deps.staticHandler?.(request);
			return served ?? notFound(url.pathname);
		}

		if (!isTrustedRequestMetadata(request.headers)) {
			return error(403, "forbidden_origin", "this API is reachable only from a local page");
		}

		// Last, so a browser's forged request still reads as the 403 it is. The
		// one exemption is the event stream's GET, by method and path and nothing
		// wider: `EventSource` cannot set a header, and the stream is read-only
		// and starts nothing. The attach GET spawns an agent and stays behind it.
		const isEventStream = request.method === "GET" && segments.length === 2 && segments[1] === "events";
		if (!isEventStream && !hasBearerToken(request.headers, apiToken)) {
			const response = error(401, "unauthorized", "this API needs its bearer token");
			response.headers.set("www-authenticate", "Bearer");
			return response;
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

		// /api/edit-draft
		if (segments.length === 2 && segments[1] === "edit-draft") {
			if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
			return editDraft(request);
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
				broadcaster.sendOpeningSnapshots(client, sessions.liveHandles());
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

	async function editDraft(request: Request): Promise<Response> {
		const body = await readJson<EditDraftRequest>(request);
		if (!body.ok) return body.response;
		if (typeof body.value.text !== "string") {
			return error(400, "bad_request", "text is required and must be a string");
		}
		const editor = process.env.EDITOR;
		if (!editor) return error(500, "editor_failed", "$EDITOR is not set");

		const directory = await mkdtemp(join(tmpdir(), "agentpane-draft-"));
		// Markdown gave multiline prompts useful editor mode in practice; there is no format setting to maintain.
		const filename = join(directory, "draft.md");
		try {
			await writeFile(filename, body.value.text, "utf8");
			// Deliberately outside D7's agent sandbox: this is the trusted operator's own editor.
			const exitCode = await new Promise<number>((resolve, reject) => {
				const child = spawn("sh", ["-c", 'exec $EDITOR "$1"', "agentpane-edit-draft", filename], {
					stdio: "inherit",
				});
				child.once("error", reject);
				child.once("close", (code) => resolve(code ?? 1));
			});
			if (exitCode !== 0) {
				return error(500, "editor_failed", `external editor exited with status ${exitCode}`);
			}
			const response: EditDraftResponse = { text: await readFile(filename, "utf8") };
			return json(response);
		} catch (err: unknown) {
			return error(500, "editor_failed", describe(err));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
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
		if (typeof cwd !== "string" || !isAbsolute(cwd)) {
			return error(400, "bad_request", "cwd is required and must be an absolute path");
		}
		try {
			if (!(await stat(cwd)).isDirectory()) {
				return error(400, "bad_request", "cwd must name an existing directory");
			}
		} catch {
			return error(400, "bad_request", "cwd must name an existing directory");
		}
		if (!isBackendId(backend)) return error(400, "bad_backend", `unknown backend "${backend}"`);
		// Starts the agent too, and a start that fails leaves nothing (D30).
		const ref = await sessions.create(cwd, backend, model);
		const session = sessions.summaryOf(ref);
		if (!session) return error(404, "not_found", `no such session: ${sessionKey(ref)}`);
		const response: CreateSessionResponse = { session };
		return json(response, 201);
	}

	async function sessionRoute(request: Request, ref: SessionRef): Promise<Response> {
		// GET is "open this session": spawn if needed, then everyone gets a
		// snapshot over SSE. DELETE is the one thing that kills an agent.
		if (request.method === "GET") {
			await sessions.attach(ref);
			// `summary.ref` is authoritative and may differ from the URL: attaching
			// is where a session first adopts its backend's own id (D9). Clients
			// also hear about it in the snapshot the attach broadcasts under
			// `summary.handle`, which does not move with it (D24, OW-mofuho).
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
				// Read-only, non-attaching (OW-38): selecting a session to look at must
				// not spawn one, and must not re-walk the corpus (D9). It reads the
				// one stored file for this ref through the index seam and returns its
				// mapped transcript messages. The attach-on-GET route is left untouched.
				// It asks `sessions` one thing, whether it holds the ref, so that no
				// file reads as `gone` only for a session nobody holds (D26 point 5);
				// a held one with nothing on disk yet is empty. Asked before the read:
				// asked after, a file that appeared during it for a session closed
				// meanwhile would read as gone.
				if (request.method !== "GET") return methodNotAllowed(request.method, "GET");
				const held = sessions.holds(ref);
				const turns = await deps.index.preview(ref);
				if (turns === null && !held) return error(404, "gone", `no such session: ${sessionKey(ref)}`);
				const response: SessionPreviewResponse = { ref, turns: turns ?? [] };
				return json(response);
			}
			case "prompt": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const body = await readJson<PromptRequest>(request);
				if (!body.ok) return body.response;
				if (typeof body.value.text !== "string") {
					return error(400, "bad_request", "text is required");
				}
				const { priorErrorId } = body.value;
				if (priorErrorId !== undefined && priorErrorId !== null && typeof priorErrorId !== "string") {
					return error(400, "bad_request", "priorErrorId must be a string or null");
				}
				// Which error the sender held when the user sent, by id: only that one
				// may go at admission. One raised after -- while this request was on
				// its way, or during admission with this one's text -- is not one the
				// sender saw (OW-31, OW-bipume, OW-lameke, OW-jokoto); see
				// `SessionManager.submit`. A sender that names none gets the error
				// held now.
				const priorError = priorErrorId === undefined ? sessions.errorIdOf(ref) : priorErrorId;
				// Only the GET above and a create start a session (D25, D30): a prompt that arrives
				// for one not attached, a close under way included, is refused.
				if (!sessions.isAttached(ref)) return notAttached(ref);
				// Through the manager, not straight at the adapter: it queues the
				// prompt behind the session's other verbs (D24).
				//
				// Both production adapters resolve submit() once the backend has
				// admitted the turn, not when the turn completes. Await that boundary
				// before acknowledging the POST so a rejected admission remains a
				// normal HTTP failure and the browser can preserve its draft.
				//
				// A prompt the backend consumed without starting a turn for it is
				// answered 200 with a body saying so (OW-dulipe); an extension's own
				// work may still stream (`PromptDisposition`). A started one keeps
				// today's bodiless 202.
				const disposition = await sessions.submit(ref, body.value.text, body.value.images, priorError);
				if (disposition === "handled") {
					const response: PromptResponse = { disposition };
					return json(response);
				}
				return accepted();
			}
			case "abort": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const adapter = requireAttached(ref);
				// The prompts the stop took out of the backend's queue go back to
				// this caller alone, as its answer and never as an event: the
				// composer to refill is the one that pressed Stop (D16, OW-wisifo).
				const queued = await adapter.abort();
				if (queued.length > 0) {
					const response: AbortResponse = { queued };
					return json(response);
				}
				return noContent();
			}
			case "compact": {
				// Like abort, this acts on a session already attached -- compaction
				// only makes sense against a live context. The adapter's reducer is
				// what turns the backend's compaction events into the transcript
				// marker; this route just admits the request (OW-72).
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				await sessions.compact(ref);
				return noContent();
			}
			case "error": {
				// The server holds the error for every later snapshot (OW-bipume), so a
				// dismissal the server never heard of would come back on the next one.
				if (request.method !== "DELETE") return methodNotAllowed(request.method, "DELETE");
				const body = await readJson<DismissErrorRequest>(request);
				if (!body.ok) return body.response;
				if (typeof body.value.errorId !== "string") {
					return error(400, "bad_request", "errorId is required");
				}
				sessions.clearError(ref, body.value.errorId);
				return noContent();
			}
			case "fork": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const body = await readJson<ForkRequest>(request);
				if (!body.ok) return body.response;
				if (typeof body.value.entryId !== "string") {
					return error(400, "bad_request", "entryId is required");
				}
				// Only an attached session forks (D25). Through the manager, not
				// straight at the adapter: it queues the fork and keeps what the
				// attach of the fork will need (see SessionManager.fork).
				if (!sessions.isAttached(ref)) return notAttached(ref);
				const forked = await sessions.fork(ref, body.value.entryId);
				// The backends' forks are asymmetric, settled live (see
				// docs/MANUAL_TESTING.md, HANDOFF findings 43-46, OW-pifowo/OW-22 for Pi
				// and Codex, OW-yilabe/OW-mayuza for Claude Code):
				//   * Pi's `fork` is copy-on-write. The same process's active
				//     `sessionFile` MOVES to a new file (the old branch survives on
				//     disk byte-identical), and the adapter announces the move, so
				//     the manager moves the adapter onto a container of its own,
				//     with a handle of its own, through `#forkOnto` before the fork
				//     hydrates. Nothing under the parent's handle names the fork:
				//     the parent is a second conversation, not an older name
				//     (OW-suhoto). The ref it returns is the moved file.
				//   * Codex's `thread/fork` mints a NEW thread the parent's adapter is
				//     not driving; Codex flushes that rollout to disk immediately,
				//     before any turn (as of `codex-cli` 0.154.0, D9). The index
				//     therefore finds it, but nothing else may open it: as of
				//     `codex-cli` 0.154.0 the minting app-server holds its writer
				//     lock and a second one is refused, so the fork's adapter borrows
				//     the parent's connection and `fork()` hands that adapter over
				//     for `SessionManager` to start (OW-lajehi). The parent adapter's
				//     own ref is unchanged, so nothing moves.
				//     A fork at the first user message is the exception: no
				//     `thread/fork` keeps nothing, so it mints nothing and takes
				//     Claude Code's path below, a `virtual:` ref renamed at attach to
				//     the thread its own `thread/start` names (OW-hojefo).
				//   * Claude Code's fork mints the forked session's id and the
				//     arguments that spawn it (`--resume --resume-session-at
				//     --fork-session --session-id`, truncation inclusive of the named
				//     entry) but runs nothing, so like Codex the parent's ref is
				//     unchanged and nothing moves. Nothing has written the fork's
				//     store file yet, so the attach on the returned ref spawns it from
				//     the recipe `SessionManager.fork` kept (OW-razoki).
				// `#forkOnto` already emits `sessionsChanged` when a fork moves the
				// adapter, so no explicit broadcast here.
				const response: ForkResponse = { ref: forked };
				return json(response, 201);
			}
			case "fork-and-prompt": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const body = await readJson<ForkAndPromptRequest>(request);
				if (!body.ok) return body.response;
				if (!Number.isInteger(body.value.index)) return error(400, "bad_request", "index must be an integer");
				if (typeof body.value.text !== "string") return error(400, "bad_request", "text is required");
				// Only an attached session forks (D25). The manager runs the rest as
				// one operation (D30): the fork at the index, its attach and its
				// prompt; a failure after the fork exists names it, in `fetch` below.
				if (!sessions.isAttached(ref)) return notAttached(ref);
				const response: ForkAndPromptResponse = await sessions.forkAndPrompt(
					ref,
					body.value.index,
					body.value.text,
					body.value.images,
				);
				return json(response, 201);
			}
			case "fork-points": {
				if (request.method !== "GET") return methodNotAllowed(request.method, "GET");
				const adapter = sessions.adapterFor(ref);
				if (!adapter) return notAttached(ref);
				const response: ForkPointsResponse = { points: await adapter.listForkPoints(), forkStopsTurn: adapter.forkStopsTurn };
				return json(response);
			}
			case "model": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const body = await readJson<SetModelRequest>(request);
				if (!body.ok) return body.response;
				if (typeof body.value.model !== "string") {
					return error(400, "bad_request", "model is required");
				}
				if (!sessions.isAttached(ref)) return notAttached(ref);
				await sessions.setModel(ref, body.value.model);
				return noContent();
			}
			case "name": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const body = await readJson<SetNameRequest>(request);
				if (!body.ok) return body.response;
				// One rule for all three backends, Pi's: as of `pi 1.0.0` it trims a
				// name, refuses one empty after that, and stores line breaks as one
				// space (`set_session_name` in `rpc-mode.js`, `appendSessionInfo`).
				const name = typeof body.value.name === "string" ? body.value.name.replace(/[\r\n]+/g, " ").trim() : "";
				if (name === "") return error(400, "bad_request", "name is required and must not be blank");
				// Written through, so only a session with a process to write to
				// (D13, "Names are not marks"). The adapter's state change is what
				// sends `sessions-changed` (`SessionManager.#onUpdate`).
				if (!sessions.isAttached(ref)) return notAttached(ref);
				await sessions.setName(ref, name);
				return noContent();
			}
			case "effort": {
				if (request.method !== "POST") return methodNotAllowed(request.method, "POST");
				const body = await readJson<SetEffortRequest>(request);
				if (!body.ok) return body.response;
				if (typeof body.value.effort !== "string") {
					return error(400, "bad_request", "effort is required");
				}
				if (!sessions.isAttached(ref)) return notAttached(ref);
				// The manager refuses a level the model does not list, with
				// `EffortNotOfferedError` (OW-tewofe).
				await sessions.setEffort(ref, body.value.effort);
				return noContent();
			}
			default:
				return notFound(`/api/sessions/${ref.backend}/.../${action}`);
		}
	}

	/**
	 * The refusal of a route that acts on a running session, sent for one that
	 * is not: only the attach route, the GET of `ROUTES.session`, starts one
	 * (D25). A 409 and not a 404, since the session exists and is listed.
	 */
	function notAttached(ref: SessionRef): Response {
		return error(409, "not_attached", `session ${sessionKey(ref)} is not attached`);
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
			// that has not been started rejects with "Pi process is not running".
			// A filtered request surfaces that failure to its caller; the merged
			// request still omits Pi so another backend's useful answer survives.
			// Spawning to answer a *listing* question is exactly what D9 rules out.
			const live = sessions
				.liveRefs()
				.filter((ref) => ref.backend === id)
				.map((ref) => sessions.adapterFor(ref))
				.find((adapter) => adapter !== undefined);
			let adapter: BackendAdapter;
			try {
				adapter = live ?? factory.create({ backend: id, id: "" });
			} catch (cause) {
				// A factory that will not construct without a real id is still not
				// grounds for failing the other backend's list.
				if (backend !== null) throw cause;
				continue;
			}
			try {
				models.push(...(await adapter.listModels()));
			} catch (cause) {
				// Ditto for a backend that cannot enumerate without a subprocess.
				if (backend !== null) throw cause;
			} finally {
				if (!live) await Promise.resolve(adapter.dispose()).catch(() => {});
			}
		}
		const body: ModelsResponse = { models };
		return json(body);
	}

	return {
		async fetch(request: Request): Promise<Response> {
			try {
				return await handle(request);
			} catch (thrown) {
				// A fork-and-prompt that failed after its fork was created answers as
				// its cause would, and names the fork beside it (D30).
				const err = thrown instanceof ForkNotPromptedError ? thrown.cause : thrown;
				const fork = thrown instanceof ForkNotPromptedError ? thrown.fork : undefined;
				if (err instanceof UnknownSessionError) return error(404, "not_found", err.message, fork);
				if (err instanceof UnknownBackendError) return error(501, "no_backend", err.message, fork);
				if (err instanceof ServerShuttingDownError) {
					return error(503, "server_shutting_down", err.message, fork);
				}
				if (err instanceof BackendRefusedError) return error(400, "backend_refused", err.message, fork);
				if (err instanceof EffortNotOfferedError) return error(400, "bad_request", err.message, fork);
				if (err instanceof NotAForkPointError) return error(409, "not_a_fork_point", err.message, fork);
				const ref = sessionRefFromRequest(request);
				logError(`${ref ? `session ${sessionKey(ref)}: ` : ""}${describe(err)}`);
				return error(500, "internal_error", describe(err), fork);
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
	return value === "pi" || value === "codex" || value === "claude";
}

function sessionRefFromRequest(request: Request): SessionRef | undefined {
	const segments = new URL(request.url).pathname
		.split("/")
		.filter((segment) => segment.length > 0)
		.map(decodeSegment);
	if (segments[0] !== "api" || segments[1] !== "sessions" || segments.length < 4) {
		return undefined;
	}
	const backend = segments[2];
	const id = segments[3];
	return isBackendId(backend) && id !== undefined ? { backend, id } : undefined;
}

/**
 * D8 binds 127.0.0.1 so nothing off this machine can reach us. That closes the
 * network, not the browser: any page in any tab can issue cross-origin requests
 * to a loopback port, and a `POST` with a simple content type is not preflighted
 * — so `evil.com` cannot *read* our replies, but it can drive them. Every route
 * behind here spawns sandboxed agents with write access to the user's
 * repositories, which makes a blind write plenty.
 *
 * This stops a browser, not a local process, which can send any header; the
 * bearer token below is what stops that (D29, which overturned D8's "no auth
 * needs to exist once remote access is off the table"). pipane has no origin
 * check either (HANDOFF finding 17), which is where the gap was inherited from.
 *
 * The Origin rule is loopback-*origin*, not same-origin: in dev the page is
 * served by Vite on another port and proxied here, so an exact match would
 * reject the only client we have. Browsers can omit Origin on cross-site
 * no-CORS GETs, so Sec-Fetch-Site closes that gap: when present it must say
 * `same-origin` or `none`. Header absence passes this check for non-browser
 * clients such as curl, which still need the bearer token and a loopback `Host`
 * (D29), while the production and proxied development clients are same-origin
 * and send `same-origin`.
 */
function isTrustedRequestMetadata(headers: Headers): boolean {
	const site = headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return false;
	return isLoopbackOrigin(headers.get("origin"));
}

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
	return isLoopbackHostname(hostname);
}

/**
 * DNS rebinding gets past the Origin check above: a page whose own name has
 * been pointed at 127.0.0.1 is same-origin with us as far as the browser can
 * tell, so it sends `Sec-Fetch-Site: same-origin` and an Origin naming itself
 * only on the requests that carry one. What it cannot hide is that name, in the
 * `Host` header, so every request -- the static bundle included -- must name
 * loopback there. Any port: an `ssh -L` forward may pick its own local port,
 * and the Vite dev proxy forwards with `changeOrigin: false`, so we see its.
 *
 * The header is read directly rather than through `request.url`. As of
 * `bun 1.4.0` `Bun.serve` builds the URL from it anyway, but a `Request` built
 * in-process keeps its own URL beside whatever header it was given. With no
 * header the URL is all there is: in-process it is the test's own, and from
 * Bun it is relative -- an HTTP/1.0 request that names no host -- which does
 * not parse and is refused. (HTTP/1.1 without one Bun answers 400 itself.)
 *
 * This stops a browser, not a local process, which can send any header.
 */
function isLoopbackHost(request: Request): boolean {
	const host = request.headers.get("host");
	if (host === null) {
		try {
			return isLoopbackHostname(new URL(request.url).hostname);
		} catch {
			return false;
		}
	}
	// `uri-host [ ":" port ]` taken apart by hand: `new URL` would read
	// `evil.example@127.0.0.1` as userinfo and hand back a loopback hostname.
	const match = /^(\[[^\]]*\]|[^:]*)(?::\d*)?$/.exec(host);
	return match !== null && isLoopbackHostname((match[1] as string).toLowerCase());
}

/**
 * The loopback bind and the checks above stop a browser; a local process can
 * send any header, so what stops it is a secret it cannot read. Only from the
 * `Authorization` header, never a cookie, which a browser attaches on its own,
 * or a query parameter, which lands in logs and history.
 *
 * Constant-time over equal lengths. A length mismatch still runs the same
 * comparison, of the token against itself, so the time spent says nothing
 * about how much of a guess was right.
 */
function hasBearerToken(headers: Headers, expected: Buffer): boolean {
	const match = /^Bearer +(\S+)$/i.exec(headers.get("authorization") ?? "");
	if (match === null) return false;
	const given = Buffer.from(match[1] as string, "utf8");
	const sameLength = given.length === expected.length;
	return timingSafeEqual(sameLength ? given : expected, expected) && sameLength;
}

function isLoopbackHostname(hostname: string): boolean {
	// Anchored, because `127.0.0.0/8` is all loopback but `startsWith("127.")`
	// also accepts `127.0.0.1.evil.example`, which is a name someone else owns.
	// Caught by the tests in `app.test.ts`, not by reading this back.
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

/** The prompt route, for a started prompt: the turn is accepted, its events come over SSE. */
function accepted(): Response {
	return new Response(null, { status: 202 });
}

function error(status: number, code: string, detail?: string, fork?: ApiError["fork"]): Response {
	const body: ApiError = {
		error: code,
		...(detail === undefined ? {} : { detail }),
		...(fork === undefined ? {} : { fork }),
	};
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
