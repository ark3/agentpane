/**
 * One `codex app-server` child, held by N adapters.
 *
 * Codex forks inside a live process and that process keeps the new thread's
 * writer lock: a second app-server answering `thread/resume` on a forked thread
 * is refused with JSON-RPC `-32600`, `already has an active writer`, while the
 * process that minted the fork resumes it, drives a turn on it, and keeps
 * driving the parent afterwards (home server, 2026-09-15, `codex-cli 0.154.0`;
 * `docs/MANUAL_TESTING.md`, "The app-server that mints a fork can also drive
 * it", OW-lajehi). So the fork's adapter borrows this connection instead of
 * spawning its own, and the child outlives every holder but the last. N, not
 * two: a fork of a fork sends `thread/fork` over this same connection.
 *
 * One `CodexClient` for every holder, not one each: two would both number
 * from 1 over the same line stream, so one's response would settle the
 * other's request of that id.
 *
 * A holder letting go does NOT let go of its thread: after
 * `thread/unsubscribe` answers `{"status":"unsubscribed"}`, a second
 * app-server resuming the thread is still refused with `-32600`, whether this
 * process resumed it or minted it (home server, 2026-09-15, `codex-cli
 * 0.154.0`; `docs/MANUAL_TESTING.md`, "`thread/unsubscribe` does not release
 * a Codex thread's writer lock", OW-voyezi). Only the child's death releases
 * it, so while any holder keeps this connection open, every thread it has
 * opened stays this child's, and re-attaching one must come back HERE
 * (`CodexConnectionRegistry`).
 */

import { CodexClient, type CodexClientView } from "./jsonrpc.ts";
import type { CodexProcess } from "./process.ts";
import { isCodexNotification, isCodexServerRequest, isRecord, type CodexServerMessage, type RequestId } from "./protocol.ts";

export interface CodexConnectionHandlers {
	/** Notifications and `ServerRequest`s -- everything we did not ask for. */
	onMessage: (msg: CodexServerMessage) => void;
	/** A line whose handling threw, as the shell reports it. */
	onError: (message: string) => void;
	onExit: (code: number | null, signal: string | null, error?: Error) => void;
}

export class CodexConnection {
	readonly client: CodexClient;
	/** Join order. The first entry is the adapter that opened the connection. */
	readonly #holders: CodexConnectionHolder[] = [];
	#kill: Promise<void> | null = null;

	constructor(
		readonly proc: CodexProcess,
		private readonly registry?: CodexConnectionRegistry,
	) {
		this.client = new CodexClient(proc, {
			onMessage: (msg) => this.#deliver(msg),
			// Every holder: the shell cannot say whose handler threw, and the
			// holders after it in `#deliver` never had the line.
			onThrow: (message) => {
				for (const holder of [...this.#holders]) holder.handlers.onError(message);
			},
			onExit: (code, signal, error) => {
				// A dead app-server holds nothing, so nothing may be sent back here.
				this.registry?.forget(this);
				// Every holder, not just the one that spawned the child: a dead
				// app-server ends all of these sessions, and a holder that is not
				// told leaves its session attached over a dead child.
				for (const holder of [...this.#holders]) holder.handlers.onExit(code, signal, error);
			},
		});
	}

	join(handlers: CodexConnectionHandlers): CodexConnectionHolder {
		const holder = new CodexConnectionHolder(this, handlers);
		this.#holders.push(holder);
		return holder;
	}

	/**
	 * Let go of one holder's share. Only the last one out disposes the client
	 * and kills the child; everybody else resolves at once, having rejected
	 * nothing but their own outstanding requests.
	 *
	 * That splits the adapter contract's "dispose resolves only once the child is
	 * gone" across the set rather than breaking it -- see `BackendAdapter.dispose`.
	 */
	release(holder: CodexConnectionHolder, reason: string): Promise<void> {
		// `CodexConnectionHolder.release` latches before delegating and nothing
		// else touches `#holders`, so this runs exactly once per holder.
		this.#holders.splice(this.#holders.indexOf(holder), 1);
		if (this.#holders.length > 0) {
			this.client.dispose(reason, holder);
			return Promise.resolve();
		}
		this.client.dispose(reason);
		// The last holder out is the one that takes the threads with it: until
		// now this child was still the writer for every thread it had opened,
		// including those whose adapters are long gone.
		this.registry?.forget(this);
		this.#kill ??= this.proc.kill();
		return this.#kill;
	}

	/**
	 * Record that this child has opened `threadId`, so a later attach on it
	 * borrows this connection instead of spawning an app-server that would be
	 * refused. Called from `CodexConnectionHolder.claim`, which every path that
	 * opens a thread -- `thread/start`, `thread/resume`, and the fork's
	 * `adoptConnection` -- goes through.
	 */
	remember(threadId: string): void {
		this.registry?.remember(threadId, this);
	}

	#deliver(msg: CodexServerMessage): void {
		if (isCodexServerRequest(msg)) {
			// A blocking request has ONE wire id and needs ONE answer. Delivered to
			// every holder, each adapter would refuse it at arrival and write its
			// own JSON-RPC response for that id (D2a, OW-lajehi).
			this.#recipientFor(threadIdOfParams(msg.params))?.handlers.onMessage(msg);
			return;
		}
		// Notifications go to everyone and each reducer drops what is not its
		// thread's (`reducer.ts`, `handleNotification`'s guard). That guard is the
		// same one D19's subagent threads already rely on -- save for a warning
		// naming a thread no holder drives, which would reach no session at all.
		// That is usually a subagent's thread, but a closed session's thread
		// still running here is one too. A dropped warning is one nobody can ever
		// learn of, so it goes out as though it named no thread, and every
		// session this app-server serves hears it, as the `CodexAdapter.onNotice`
		// docblock describes for a thread-less one (owner, 2026-09-24, OW-weyefe).
		// Which session spawned a subagent cannot be read off the wire, as
		// `#recipientFor` explains. The cast covers `guardianWarning`, whose
		// generated `threadId` is a non-null string; the reducer reads it through
		// `threadIdOf`, which takes a null.
		const delivered =
			isCodexNotification(msg) &&
			(msg.method === "warning" || msg.method === "guardianWarning") &&
			!this.#holders.some((holder) => holder.threadId === msg.params.threadId)
				? ({ ...msg, params: { ...msg.params, threadId: null } } as CodexServerMessage)
				: msg;
		for (const holder of [...this.#holders]) holder.handlers.onMessage(delivered);
	}

	/**
	 * Who answers a blocking request from `threadId`: the holder driving that
	 * thread, else the connection's first.
	 *
	 * A thread nobody drives is a spawned subagent's, whose request D19 would
	 * surface in the session that spawned it, but no approval or elicitation
	 * params name the parent thread, so that session cannot be read off the
	 * wire. The first holder is deterministic and spawned the connection, and
	 * being wrong costs only attribution: the refusal carries the wire id, so
	 * it still unblocks the right child. "Whoever is mid-turn" would still
	 * need a tie-break, since a fork and its parent can stream at once; and
	 * under D7a's `approvalPolicy: "never"` no approval request had been seen
	 * reaching agentpane as of `codex-cli 0.154.0` (D18, OW-zogogo).
	 *
	 * Only an `answerable` holder is a candidate, for its own thread too: a
	 * borrower joins at fork time, to hold its share across a `close()` on the
	 * parent, but nothing has subscribed to it until the fork's own start, and
	 * a blocking request handed to it then is D2a's silent stall, pinning this
	 * connection.
	 */
	#recipientFor(threadId: string | null): CodexConnectionHolder | undefined {
		const answerable = this.#holders.filter((holder) => holder.answerable);
		if (threadId) {
			const owner = answerable.find((holder) => holder.threadId === threadId);
			if (owner) return owner;
		}
		return answerable[0];
	}
}

/**
 * One adapter's share of a connection. It wears `CodexClientView`, so the
 * adapter holding it cannot tell a borrowed connection from an owned one, and
 * it tags every request with itself so a release rejects that adapter's
 * outstanding calls and nobody else's.
 */
export class CodexConnectionHolder implements CodexClientView {
	/** The thread this holder drives, once it is known. Set before it can matter. */
	threadId: string | null = null;
	/**
	 * Whether this holder's adapter can actually refuse a blocking request: it
	 * has been started, so whoever attached it has subscribed, and it has not
	 * been disposed. False for the whole of the window between a fork minting a
	 * borrower and that borrower being attached -- see `#recipientFor`.
	 */
	answerable = false;
	#released = false;

	constructor(
		private readonly connection: CodexConnection,
		readonly handlers: CodexConnectionHandlers,
	) {}

	get proc(): CodexProcess {
		return this.connection.proc;
	}

	claim(threadId: string): void {
		this.threadId = threadId;
		this.connection.remember(threadId);
	}

	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		return this.connection.client.request<T>(method, params, this);
	}

	respond(id: RequestId, result: unknown): void {
		this.connection.client.respond(id, result);
	}

	respondError(id: RequestId, code: number, message: string): void {
		this.connection.client.respondError(id, code, message);
	}

	/** Idempotent, like the `dispose()` it is called from. */
	release(reason = "adapter disposed"): Promise<void> {
		if (this.#released) return Promise.resolve();
		this.#released = true;
		return this.connection.release(this, reason);
	}
}

/**
 * Which live `codex app-server` holds a thread, for the attaches that must not
 * spawn (OW-voyezi): a thread outlives the adapter that opened it while a
 * borrower keeps its child alive (`CodexConnection`'s docblock).
 *
 * One instance per `CodexAdapterFactory`, handed to every adapter it builds and
 * to the borrowers those adapters mint; not a module-level singleton, since
 * two factories in one process (the tests build several) must not see each
 * other's children.
 *
 * Entries are dropped by the connection itself, on the last release and on the
 * child's exit -- never by an adapter disposing, which is the whole point.
 */
export class CodexConnectionRegistry {
	readonly #byThread = new Map<string, CodexConnection>();

	remember(threadId: string, connection: CodexConnection): void {
		this.#byThread.set(threadId, connection);
	}

	find(threadId: string): CodexConnection | undefined {
		return this.#byThread.get(threadId);
	}

	forget(connection: CodexConnection): void {
		for (const [threadId, held] of this.#byThread) {
			if (held === connection) this.#byThread.delete(threadId);
		}
	}
}

/**
 * The thread a `ServerRequest` came from, under either of the two names the
 * generated params use for it.
 *
 * Six of the ten kinds in `ServerRequest.ts` carry `threadId`. The two
 * deprecated ones -- `applyPatchApproval` and `execCommandApproval` -- name the
 * same thing `conversationId: ThreadId`, so reading only `threadId` would send
 * a fork's own legacy approval to the fallback and attribute it to the parent.
 * The remaining two carry no thread at all and answer null:
 * `account/chatgptAuthTokens/refresh` has only a `reason`, and
 * `attestation/generate` is `Record<string, never>`.
 */
function threadIdOfParams(params: unknown): string | null {
	if (!isRecord(params)) return null;
	if (typeof params.threadId === "string") return params.threadId;
	return typeof params.conversationId === "string" ? params.conversationId : null;
}
