/**
 * Request/response correlation over a `CodexProcess`.
 *
 * app-server multiplexes three things down one pipe: responses to requests we
 * sent, notifications, and `ServerRequest`s that block the turn until we answer
 * (D2a). This class owns only the first -- it hands the other two straight to
 * the reducer -- which keeps the id bookkeeping in one small, boring place.
 */

import { isRecord, type CodexResponse, type CodexServerMessage, type RequestId } from "./protocol.ts";
import type { CodexProcess } from "./process.ts";

export class CodexRpcError extends Error {
	constructor(
		message: string,
		readonly code?: number,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "CodexRpcError";
	}
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	method: string;
}

export class CodexClient {
	private nextId = 1;
	private pending = new Map<string, Pending>();
	private closed: Error | null = null;

	constructor(
		private proc: CodexProcess,
		handlers: {
			/** Notifications and `ServerRequest`s -- everything we did not ask for. */
			onMessage: (msg: CodexServerMessage) => void;
			/** A line that was not JSON. Rare, but never fatal. */
			onMalformed?: (line: string) => void;
			onExit?: (code: number | null, signal: string | null, error?: Error) => void;
		},
	) {
		proc.onLine((line) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				handlers.onMalformed?.(line);
				return;
			}
			if (!isRecord(parsed)) {
				handlers.onMalformed?.(line);
				return;
			}
			if (isValidResponse(parsed)) {
				this.settle(parsed as CodexResponse);
				return;
			}
			if (isValidPushedEnvelope(parsed)) {
				handlers.onMessage(parsed as CodexServerMessage);
				return;
			}
			handlers.onMalformed?.(line);
		});

		proc.onExit((code, signal, cause) => {
			const error = new CodexRpcError(
				cause?.message ?? `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			);
			this.fail(error);
			if (cause) handlers.onExit?.(code, signal, error);
			else handlers.onExit?.(code, signal);
		});
	}

	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		if (this.closed) return Promise.reject(this.closed);
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const key = String(id);
			this.pending.set(key, { resolve: resolve as (value: unknown) => void, reject, method });
			try {
				this.send({ id, method, params: params ?? {} });
			} catch (error) {
				this.pending.delete(key);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** Answer a `ServerRequest`. Until this lands, the Codex turn is blocked. */
	respond(id: RequestId, result: unknown): void {
		this.send({ id, result });
	}

	respondError(id: RequestId, code: number, message: string): void {
		this.send({ id, error: { code, message } });
	}

	/** Reject everything outstanding; further requests fail fast. */
	dispose(reason = "adapter disposed"): void {
		this.fail(new CodexRpcError(reason));
	}

	private send(payload: unknown): void {
		this.proc.write(JSON.stringify(payload));
	}

	private settle(msg: CodexResponse): void {
		const key = String(msg.id);
		const pending = this.pending.get(key);
		if (!pending) return; // a response to a request we never made, or a late duplicate
		this.pending.delete(key);
		if (msg.error) {
			pending.reject(
				new CodexRpcError(msg.error.message ?? `${pending.method} failed`, msg.error.code, msg.error.data),
			);
		} else {
			pending.resolve(msg.result);
		}
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = error;
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) entry.reject(error);
	}
}

function isValidResponse(envelope: Record<string, unknown>): boolean {
	if (!isRequestId(envelope["id"]) || "method" in envelope) return false;
	const hasResult = Object.hasOwn(envelope, "result");
	const hasError = Object.hasOwn(envelope, "error");
	if (hasResult === hasError) return false;
	if (!hasError) return true;
	const error = envelope["error"];
	return isRecord(error) && typeof error["code"] === "number" && typeof error["message"] === "string";
}

function isValidPushedEnvelope(envelope: Record<string, unknown>): boolean {
	if (typeof envelope["method"] !== "string" || "result" in envelope || "error" in envelope) return false;
	return !("id" in envelope) || isRequestId(envelope["id"]);
}

function isRequestId(value: unknown): value is RequestId {
	return typeof value === "string" || typeof value === "number";
}
