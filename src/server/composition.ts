import { sessionKey } from "../shared/protocol.ts";
import { PiAdapterFactory } from "./adapters/pi/index.ts";
import type { AppDeps, SessionIndex } from "./http/deps.ts";
import { listSessions } from "./sessions/index.ts";

export interface CompositionOptions {
	index?: SessionIndex;
	adapters?: AppDeps["adapters"];
}

/** Connects the HTTP session-index seam to the filesystem-only enumerator. */
export function createSessionIndex(): SessionIndex {
	return {
		list: (query) => listSessions(query),
		async get(ref) {
			const sessions = await listSessions();
			return sessions.find((item) => sessionKey(item.ref) === sessionKey(ref)) ?? null;
		},
	};
}

/** Production dependencies that do not start an agent until one is attached. */
export function createProductionDeps(
	options: CompositionOptions = {},
): Pick<AppDeps, "index" | "adapters"> {
	return {
		index: options.index ?? createSessionIndex(),
		adapters: options.adapters ?? { pi: new PiAdapterFactory() },
	};
}
