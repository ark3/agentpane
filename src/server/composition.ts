import { ClaudeAdapterFactory } from "./adapters/claude/index.ts";
import { CodexAdapterFactory } from "./adapters/codex/index.ts";
import { PiAdapterFactory } from "./adapters/pi/index.ts";
import type { AppDeps, SessionIndex } from "./http/deps.ts";
import { getSession, listSessions } from "./sessions/index.ts";
import { readSessionPreview } from "./sessions/preview.ts";

export interface CompositionOptions {
	index?: SessionIndex;
	adapters?: AppDeps["adapters"];
}

/** Connects the HTTP session-index seam to the filesystem-only enumerator. */
export function createSessionIndex(): SessionIndex {
	return {
		list: (query) => listSessions(query),
		// Reads exactly the one matching session file, never the corpus `list`
		// walk -- same non-attaching-cheap spirit as `preview` below.
		get: (ref) => getSession(ref),
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
			claude: new ClaudeAdapterFactory(),
		},
	};
}
