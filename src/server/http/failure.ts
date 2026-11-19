/**
 * One mapper from a failure to the code a client reads, shared by the HTTP
 * routes and the socket while both exist (D31 point 2). The HTTP routes read
 * the status as well; the socket reads only the code.
 */

import type { ApiError } from "../../shared/protocol.ts";
import { BackendRefusedError } from "../adapters/types.ts";
import {
	AttachedNotPromptedError,
	EffortNotOfferedError,
	ForkNotPromptedError,
	HandleEndedError,
	NotAForkPointError,
	ServerShuttingDownError,
	UnknownBackendError,
	UnknownSessionError,
} from "./session-manager.ts";

/**
 * A request refused for what it asked, by code that both transports share
 * (`operations.ts`, `socket.ts`): a bad parameter, a session gone, an editor
 * that failed. Each transport's own framing checks answer without it.
 */
export class Refusal extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		detail: string,
	) {
		super(detail);
		this.name = "Refusal";
	}
}

/** What a refusal names beside its cause: a fork, or a session a prompt attached (D30). */
export type Named = Pick<ApiError, "fork" | "attached">;

export interface Failure {
	status: number;
	code: string;
	detail: string;
	named: Named;
	/** Nothing above recognised it: an internal error, which the caller logs. */
	unexpected: boolean;
}

export function classifyFailure(thrown: unknown): Failure {
	// A fork-and-prompt that failed after its fork was created, and a prompt
	// naming no handle refused after its attach, answer as their cause would,
	// and name the fork or the session beside it (D30).
	const err = thrown instanceof ForkNotPromptedError || thrown instanceof AttachedNotPromptedError ? thrown.cause : thrown;
	const named: Named =
		thrown instanceof ForkNotPromptedError
			? { fork: thrown.fork }
			: thrown instanceof AttachedNotPromptedError
				? { attached: thrown.attached }
				: {};
	const known = (status: number, code: string): Failure => ({ status, code, detail: describe(err), named, unexpected: false });
	if (err instanceof Refusal) return known(err.status, err.code);
	if (err instanceof UnknownSessionError) return known(404, "not_found");
	if (err instanceof HandleEndedError) return known(409, "not_attached");
	if (err instanceof UnknownBackendError) return known(501, "no_backend");
	if (err instanceof ServerShuttingDownError) return known(503, "server_shutting_down");
	if (err instanceof BackendRefusedError) return known(400, "backend_refused");
	if (err instanceof EffortNotOfferedError) return known(400, "bad_request");
	if (err instanceof NotAForkPointError) return known(409, "not_a_fork_point");
	return { ...known(500, "internal_error"), unexpected: true };
}

export function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
