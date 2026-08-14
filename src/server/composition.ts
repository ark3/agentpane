import { sessionKey } from "../shared/protocol.ts";
import { CodexAdapterFactory } from "./adapters/codex/index.ts";
import { PiAdapterFactory } from "./adapters/pi/index.ts";
import type { AppDeps, SessionIndex } from "./http/deps.ts";
import { listSessions } from "./sessions/index.ts";
import { readSessionPreview } from "./sessions/preview.ts";

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
		// Non-attaching preview (OW-38): reads exactly the one session file, never
		// the corpus `list`/`get` walk.
		preview: (ref) => readSessionPreview(ref),
	};
}

/** Production dependencies that do not start an agent until one is attached. */
export function createProductionDeps(
	options: CompositionOptions = {},
): Pick<AppDeps, "index" | "adapters"> {
	return {
		index: options.index ?? createSessionIndex(),
		adapters: options.adapters ?? {
			pi: new PiAdapterFactory(),
			codex: new CodexAdapterFactory(),
		},
	};
}
