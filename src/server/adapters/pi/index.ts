/**
 * Public surface of the Pi adapter (WORKSTREAMS.md: this workstream owns
 * `src/server/adapters/pi/` and nothing else).
 */

import type { SessionRef } from "../../../shared/protocol.ts";
import type { AdapterFactory, BackendAdapter } from "../types.ts";
import { PiAdapter } from "./process.ts";

export { LfLineSplitter } from "./framing.ts";
export { PiAdapter } from "./process.ts";
export {
	buildUiReplyCommand,
	createInitialPiState,
	type PiReduceResult,
	type PiReducerState,
	reducePiNotification,
} from "./reducer.ts";
export { buildPiSpawnCommand, type PiSpawnCommand, type PiSpawnOptions } from "./spawn.ts";
export {
	modelToInfo,
	type PiAssistantMessageEvent,
	type PiCommand,
	type PiCommandType,
	type PiDialogMethod,
	type PiExtensionUiRequestEvent,
	type PiNotification,
	type PiOutputLine,
	type PiResponse,
	type PiResponseFor,
	splitModelRef,
} from "./protocol.ts";

export class PiAdapterFactory implements AdapterFactory {
	create(ref: SessionRef): BackendAdapter {
		if (ref.backend !== "pi") {
			throw new Error(`PiAdapterFactory cannot create a "${ref.backend}" adapter`);
		}
		return new PiAdapter(ref);
	}
}
