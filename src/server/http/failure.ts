/**
 * One mapper from a failure to the code a client reads in a refused reply
 * (D31 point 2).
 */

import type { ApiError } from "../../shared/protocol.ts";
import { BackendRefusedError } from "../adapters/types.ts";
import {
	AtCapacityError,
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
 * A command refused for what it asked (`operations.ts`, `socket.ts`): a bad
 * parameter, a session gone, an editor that failed. A frame the socket cannot
 * read at all is not refused but closes it (`SOCKET_CLOSE`).
 */
export class Refusal extends Error {
	constructor(
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
	code: string;
	detail: string;
	named: Named;
	/** Nothing above recognised it: an internal error, which the caller logs. */
	unexpected: boolean;
}

export function classifyFailure(thrown: unknown): Failure {
	// A fork-and-prompt that failed after its fork was created, and a prompt
	// naming a ref refused after its attach, answer as their cause would,
	// and name the fork or the session beside it (D30).
	const err = thrown instanceof ForkNotPromptedError || thrown instanceof AttachedNotPromptedError ? thrown.cause : thrown;
	const named: Named =
		thrown instanceof ForkNotPromptedError
			? { fork: thrown.fork }
			: thrown instanceof AttachedNotPromptedError
				? { attached: thrown.attached }
				: {};
	const known = (code: string): Failure => ({ code, detail: describe(err), named, unexpected: false });
	if (err instanceof Refusal) return known(err.code);
	if (err instanceof UnknownSessionError) return known("not_found");
	if (err instanceof HandleEndedError) return known("not_attached");
	if (err instanceof UnknownBackendError) return known("no_backend");
	if (err instanceof ServerShuttingDownError) return known("server_shutting_down");
	if (err instanceof AtCapacityError) return known("at_capacity");
	if (err instanceof BackendRefusedError) return known("backend_refused");
	if (err instanceof EffortNotOfferedError) return known("bad_request");
	if (err instanceof NotAForkPointError) return known("not_a_fork_point");
	return { ...known("internal_error"), unexpected: true };
}

export function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
