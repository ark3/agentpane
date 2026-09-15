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
 * spawning its own, and the child outlives every holder but the last.
 *
 * Sharing the `CodexProcess` and giving each adapter its own `CodexClient`
 * would be a quieter-looking bug: both clients start `nextId = 1` and both read
 * the same line stream, so one adapter's response settles the other adapter's
 * request of the same id. There is exactly one id space here because there is
 * exactly one client.
 *
 * N, not two. A fork of a fork sends `thread/fork` over this same connection,
 * so its writer is this same child, and the count has no upper bound a pair
 * could express.
 */

import { CodexClient, type CodexClientView } from "./jsonrpc.ts";
import type { CodexProcess } from "./process.ts";
import { isCodexServerRequest, isRecord, type CodexServerMessage, type RequestId } from "./protocol.ts";

export interface CodexConnectionHandlers {
	/** Notifications and `ServerRequest`s -- everything we did not ask for. */
	onMessage: (msg: CodexServerMessage) => void;
	onExit: (code: number | null, signal: string | null, error?: Error) => void;
}

export class CodexConnection {
	readonly client: CodexClient;
	/** Join order. The first entry is the adapter that opened the connection. */
	readonly #holders: CodexConnectionHolder[] = [];
	#kill: Promise<void> | null = null;

	constructor(readonly proc: CodexProcess) {
		this.client = new CodexClient(proc, {
			onMessage: (msg) => this.#deliver(msg),
			onExit: (code, signal, error) => {
				// Every holder, not just the one that spawned the child: a dead
				// app-server ends all of these sessions, and a holder that is not
				// told ends silently, with no error banner and no explanation.
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
		const index = this.#holders.indexOf(holder);
		if (index < 0) return this.#kill ?? Promise.resolve();
		this.#holders.splice(index, 1);
		if (this.#holders.length > 0) {
			this.client.dispose(reason, holder);
			return Promise.resolve();
		}
		this.client.dispose(reason);
		this.#kill ??= this.proc.kill();
		return this.#kill;
	}

	#deliver(msg: CodexServerMessage): void {
		if (isCodexServerRequest(msg)) {
			// A blocking request has ONE wire id and needs ONE answer. Published to
			// every holder it would draw the approval twice, and whichever session
			// replied second would write a second JSON-RPC response for that id
			// (D2a, OW-lajehi).
			this.#recipientFor(threadIdOfParams(msg.params))?.handlers.onMessage(msg);
			return;
		}
		// Notifications go to everyone and each reducer drops what is not its
		// thread's (`reducer.ts`, `handleNotification`'s guard). That guard is the
		// same one D19's subagent threads already rely on.
		for (const holder of [...this.#holders]) holder.handlers.onMessage(msg);
	}

	/**
	 * Who answers a blocking request from `threadId`.
	 *
	 * A thread some holder is driving is answered by that holder. A thread
	 * NOBODY is driving is a spawned subagent's (D19), and D19 requires its
	 * approval to surface in the session that spawned it -- but nothing in
	 * `CommandExecutionRequestApprovalParams`, `FileChangeRequestApprovalParams`
	 * or `McpServerElicitationRequestParams` names the parent thread, so which
	 * session that is cannot be read off the wire. The connection's first holder
	 * answers instead: it is deterministic, it is the session that spawned the
	 * connection, and being wrong costs only attribution -- the reply carries the
	 * wire id, so it still unblocks the right child.
	 *
	 * Guessing by "whoever is mid-turn" was considered and declined: a fork and
	 * its parent can stream at once, so it needs a tie-break anyway and would
	 * only move where the guess is wrong. Under D7a's `approvalPolicy: "never"`
	 * no approval request has been observed reaching agentpane at all as of
	 * `codex-cli 0.154.0` (D18, OW-zogogo), so this routes an input that does not
	 * currently arrive and the cheap deterministic rule is the right size.
	 */
	#recipientFor(threadId: string | null): CodexConnectionHolder | undefined {
		if (threadId) {
			const owner = this.#holders.find((holder) => holder.threadId === threadId);
			if (owner) return owner;
		}
		return this.#holders[0];
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
 * The thread a `ServerRequest` came from. Every approval kind in
 * `ServerRequest.ts` carries `threadId`; the two deprecated legacy kinds
 * (`applyPatchApproval`, `execCommandApproval`) do not, and answer null.
 */
function threadIdOfParams(params: unknown): string | null {
	return isRecord(params) && typeof params.threadId === "string" ? params.threadId : null;
}
