/**
 * The socket (D31): one connection carries a client's commands in and their
 * replies and every event out, in the order the server wrote them.
 *
 * No runtime types: `openConnection` takes a `send` for one text frame and an
 * `end` that closes the socket, and answers `receive` for each frame that
 * arrives and `close` for when the socket has gone. `src/server/index.ts`
 * wires Bun's handlers to them; a test passes a `send` that pushes into an
 * array.
 *
 * The order needs no mechanism of its own. The broadcaster fans out
 * synchronously, and a reply is written once its command's `await` resolves,
 * so everything the command caused while it ran is written before its reply
 * (D31 point 3). Commands on different sessions reply in the order they
 * finish, which the `id` matches up; on one session the manager's queue
 * keeps them in order (D24).
 */

import { timingSafeEqual } from "node:crypto";

import {
	type CommandName,
	type Commands,
	type ServerFrame,
	SOCKET_CLOSE,
	type SessionRef,
	sessionKey,
} from "../../shared/protocol.ts";
import type { BackendAdapter } from "../adapters/types.ts";
import type { Broadcaster, EventClient } from "./broadcaster.ts";
import type { AppDeps } from "./deps.ts";
import { classifyFailure, Refusal } from "./failure.ts";
import { createSession, editDraft, isBackendId, listModels, previewSession, sessionName } from "./operations.ts";
import type { SessionManager } from "./session-manager.ts";

export interface Connection {
	/** One text frame from the client. */
	receive(text: string): void;
	/** The socket has closed, from either end. Idempotent. */
	close(): void;
}

export interface ConnectionContext {
	deps: AppDeps;
	sessions: SessionManager;
	broadcaster: Broadcaster;
	apiToken: Buffer;
	logError: (message: string) => void;
}

/**
 * Constant-time over equal lengths. A length mismatch still runs the same
 * comparison, of the token against itself, so the time spent says nothing
 * about how much of a guess was right. The socket's first frame is checked
 * with it (D29, D31 point 5).
 */
export function tokenMatches(given: string, expected: Buffer): boolean {
	const bytes = Buffer.from(given, "utf8");
	const sameLength = bytes.length === expected.length;
	return timingSafeEqual(sameLength ? bytes : expected, expected) && sameLength;
}

/** A command frame as it arrived: an object with a string `id`, the rest unchecked. */
type Frame = { id: string; cmd?: unknown } & Record<string, unknown>;

export function openConnection(
	context: ConnectionContext,
	send: (frame: string) => void,
	end: (code: number, reason: string) => void,
): Connection {
	const { sessions, broadcaster } = context;
	let closed = false;
	// Registered at the `hello`, not before: the server sends nothing and runs
	// nothing on a socket until a first frame has carried the token (D31
	// point 5), opening snapshots included.
	let client: EventClient | undefined;

	function write(frame: ServerFrame): void {
		if (closed) return;
		try {
			send(JSON.stringify(frame));
		} catch {
			// The socket went between the last write and this one, as the
			// broadcaster's client takes it; its close is on the way.
			finish();
		}
	}

	function finish(code?: number, reason?: string): void {
		if (closed) return;
		closed = true;
		// Leaves the broadcaster; a command still running carries on, since the
		// server finishes what it admitted (D17), and its reply goes nowhere.
		client?.close();
		if (code !== undefined) end(code, reason ?? "");
	}

	function hello(frame: Frame | null): void {
		if (frame?.cmd !== "hello" || typeof frame.token !== "string" || !tokenMatches(frame.token, context.apiToken)) {
			finish(SOCKET_CLOSE.unauthorized, "the first frame must be a hello carrying the token");
			return;
		}
		client = broadcaster.addClient(
			(event) => write({ type: "event", event }),
			// The broadcaster lets go of its clients only at shutdown, or when a
			// write throws, which `write` above has already taken as closed.
			() => finish(SOCKET_CLOSE.goingAway, "the server is shutting down"),
		);
		// Attach and reconnect are the same thing (D3): the client's first
		// events are a snapshot of everything live, and the hello's reply
		// follows them. There is no resume protocol.
		broadcaster.sendOpeningSnapshots(client, sessions.liveHandles());
		write({ type: "reply", id: frame.id, ok: true, result: null });
	}

	async function run(frame: Frame): Promise<void> {
		try {
			const command = typeof frame.cmd === "string" && Object.hasOwn(handlers, frame.cmd) ? handlers[frame.cmd as CommandName] : undefined;
			if (!command) throw new Refusal("bad_request", `unknown command ${JSON.stringify(frame.cmd)}`);
			const result = await command(frame);
			write({ type: "reply", id: frame.id, ok: true, result });
		} catch (thrown) {
			const failure = classifyFailure(thrown);
			if (failure.unexpected) context.logError(`${describeTarget(frame)}${failure.detail}`);
			write({ type: "reply", id: frame.id, ok: false, code: failure.code, detail: failure.detail, ...failure.named });
		}
	}

	// -- the commands ------------------------------------------------------

	type Handler = (frame: Frame) => Promise<Commands[CommandName]["result"]>;

	/** The live session a command names by its handle, or the refusal for one that has ended (D31 point 9). */
	function live(frame: Frame): { handle: string; ref: SessionRef; adapter: BackendAdapter } {
		const handle = requireString(frame, "handle");
		const found = sessions.live(handle);
		if (!found) throw new Refusal("not_attached", `no live session under handle ${handle}`);
		return { handle, ...found };
	}

	const handlers: Record<CommandName, Handler> = {
		async hello() {
			throw new Refusal("bad_request", "this socket has already said hello");
		},
		async "sessions/list"(frame) {
			const cwd = optionalString(frame, "cwd");
			return { sessions: await sessions.list(cwd ? { cwd } : undefined) };
		},
		async "sessions/create"(frame) {
			return createSession(sessions, frame.cwd, frame.backend, optionalString(frame, "model"));
		},
		async "sessions/preview"(frame) {
			return previewSession(context.deps, sessions, requireRef(frame));
		},
		async "sessions/attach"(frame) {
			const ref = requireRef(frame);
			await sessions.attach(ref);
			// `session.ref` is authoritative and may differ from the one asked
			// for: attaching is where a session first adopts its backend's own id
			// (D9). The snapshot the attach broadcast under `session.handle`,
			// already written, carries it too.
			const session = sessions.summaryOf(ref);
			if (!session) throw new Refusal("not_found", `no such session: ${sessionKey(ref)}`);
			return { session };
		},
		async "sessions/close"(frame) {
			await sessions.close(requireRef(frame));
			return null;
		},
		async "sessions/prompt"(frame) {
			const text = requireString(frame, "text");
			const images = frame.images as Commands["sessions/prompt"]["params"]["images"];
			const { priorErrorId } = frame;
			if (priorErrorId !== undefined && priorErrorId !== null && typeof priorErrorId !== "string") {
				throw new Refusal("bad_request", "priorErrorId must be a string or null");
			}
			if ((frame.handle === undefined) === (frame.ref === undefined)) {
				throw new Refusal("bad_request", "a prompt names exactly one of handle and ref");
			}
			// Which error the sender held when the user sent, by id: only that one
			// may go at admission. One raised after -- while this command was on
			// its way, or during admission with this one's text -- is not one the
			// sender saw (OW-31, OW-bipume, OW-lameke, OW-jokoto); see
			// `SessionManager.submit`. A sender that names none gets the error
			// held now. Read before any attach below, whose start may raise one
			// newer still (`PromptRequest.priorErrorId`).
			if (frame.handle !== undefined) {
				const session = live(frame);
				const priorError = priorErrorId === undefined ? sessions.errorIdOf(session.ref) : priorErrorId;
				return { disposition: await sessions.submit(session.ref, text, images, priorError, session.handle) };
			}
			const ref = requireRef(frame);
			const priorError = priorErrorId === undefined ? sessions.errorIdOf(ref) : priorErrorId;
			return sessions.attachAndSubmit(ref, text, images, priorError);
		},
		async "sessions/abort"(frame) {
			// Not queued (`SessionManager.#serially`, "Left out"): a stop must not
			// wait out a Pi compaction. The prompts it took out go back to this
			// requester alone (D16).
			return { queued: await live(frame).adapter.abort() };
		},
		async "sessions/compact"(frame) {
			const session = live(frame);
			await sessions.compact(session.ref, session.handle);
			return null;
		},
		async "sessions/dismissError"(frame) {
			const errorId = requireString(frame, "errorId");
			sessions.clearError(live(frame).ref, errorId);
			return null;
		},
		async "sessions/setModel"(frame) {
			const model = requireString(frame, "model");
			const session = live(frame);
			await sessions.setModel(session.ref, model, session.handle);
			return null;
		},
		async "sessions/setEffort"(frame) {
			const effort = requireString(frame, "effort");
			const session = live(frame);
			await sessions.setEffort(session.ref, effort, session.handle);
			return null;
		},
		async "sessions/setName"(frame) {
			const name = sessionName(frame.name);
			const session = live(frame);
			await sessions.setName(session.ref, name, session.handle);
			return null;
		},
		async "sessions/forkPoints"(frame) {
			const { adapter } = live(frame);
			return { points: await adapter.listForkPoints(), forkStopsTurn: adapter.forkStopsTurn };
		},
		async "sessions/fork"(frame) {
			const entryId = requireString(frame, "entryId");
			const session = live(frame);
			return { ref: await sessions.fork(session.ref, entryId, session.handle) };
		},
		async "sessions/forkAndPrompt"(frame) {
			if (!Number.isInteger(frame.index)) throw new Refusal("bad_request", "index must be an integer");
			const text = requireString(frame, "text");
			const images = frame.images as Commands["sessions/forkAndPrompt"]["params"]["images"];
			const session = live(frame);
			return sessions.forkAndPrompt(session.ref, frame.index as number, text, images, session.handle);
		},
		async "models/list"(frame) {
			const backend = frame.backend;
			return listModels(context.deps, sessions, backend === undefined ? null : String(backend));
		},
		async "draft/edit"(frame) {
			return { text: await editDraft(requireString(frame, "text")) };
		},
	};

	return {
		receive(text) {
			if (closed) return;
			const frame = parseFrame(text);
			if (!client) {
				hello(frame);
				return;
			}
			if (!frame) {
				finish(SOCKET_CLOSE.badFrame, "a frame must be a JSON object with a string id");
				return;
			}
			void run(frame);
		},
		close() {
			finish();
		},
	};
}

function parseFrame(text: string): Frame | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return typeof (parsed as { id?: unknown }).id === "string" ? (parsed as Frame) : null;
}

function requireString(frame: Frame, field: string): string {
	const value = frame[field];
	if (typeof value !== "string") throw new Refusal("bad_request", `${field} is required and must be a string`);
	return value;
}

function optionalString(frame: Frame, field: string): string | undefined {
	const value = frame[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Refusal("bad_request", `${field} must be a string`);
	return value;
}

function requireRef(frame: Frame): SessionRef {
	const ref = frame.ref as Partial<SessionRef> | null | undefined;
	if (ref === null || typeof ref !== "object" || typeof ref.id !== "string") {
		throw new Refusal("bad_request", "ref is required and must be { backend, id }");
	}
	if (!isBackendId(ref.backend)) throw new Refusal("bad_backend", `unknown backend "${String(ref.backend)}"`);
	return { backend: ref.backend, id: ref.id };
}

/** What an unexpected failure's log line names: the command, and the session where the frame named one. */
function describeTarget(frame: Frame): string {
	const ref = frame.ref as Partial<SessionRef> | undefined;
	const target =
		typeof frame.handle === "string"
			? ` handle ${frame.handle}`
			: ref && typeof ref.id === "string" && isBackendId(ref.backend)
				? ` session ${sessionKey({ backend: ref.backend, id: ref.id })}`
				: "";
	return `${String(frame.cmd)}${target}: `;
}
