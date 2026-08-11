/**
 * The backend adapter contract.
 *
 * FROZEN INTERFACE (DESIGN "The backend adapter contract"). The Pi and Codex
 * adapters are built in parallel against this; changing it breaks work in
 * flight -- raise it before editing.
 *
 * An adapter owns one sandboxed subprocess's stdio and is responsible for one
 * thing above all: producing and maintaining an `AgentMessage[]` plus a
 * streaming signal. The server broadcasts that state (D3); it never forwards
 * raw backend protocol events, which is what keeps the stateful item->message
 * assembly server-side, testable against fixtures, and out of the browser.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRequest, ForkPoint, ModelInfo, SessionRef } from "../../shared/protocol.ts";

export interface AdapterState {
	messages: AgentMessage[];
	isStreaming: boolean;
}

export type Unsubscribe = () => void;

export interface ImageInput {
	mimeType: string;
	base64: string;
}

export interface StartOptions {
	/**
	 * The session's workspace. The subprocess MUST be spawned with this as cwd
	 * or sbox jails the wrong tree and direnv loads the wrong environment (D7).
	 */
	cwd: string;
	/** Resume an existing session; omit to start a fresh one. */
	resumeId?: string;
	model?: string;
}

export interface BackendAdapter {
	readonly ref: SessionRef;

	// -- lifecycle ----------------------------------------------------------
	/** Spawn via `direnv exec <cwd> sbox -- <agent>` (D7). */
	start(opts: StartOptions): Promise<void>;
	dispose(): Promise<void>;

	// -- driving a turn -----------------------------------------------------
	submit(text: string, images?: ImageInput[]): Promise<void>;
	abort(): Promise<void>;

	// -- fork-from-past -----------------------------------------------------
	listForkPoints(): Promise<ForkPoint[]>;
	fork(entryId: string): Promise<SessionRef>;

	// -- state (what the server broadcasts) ---------------------------------
	getState(): AdapterState;
	/**
	 * Fires on every state change. The server translates these into snapshot /
	 * upsert events; adapters do not know about `seq` or the wire at all.
	 *
	 * `changedIndex` is the index of the single message that changed, when the
	 * adapter knows it -- that is what makes the tail-upsert path O(1). Omit it
	 * and the server falls back to a full snapshot, which is correct but
	 * quadratic over a long turn.
	 */
	onUpdate(cb: (state: AdapterState, changedIndex?: number) => void): Unsubscribe;

	/**
	 * Fires when the agent asks the human something and blocks (D2a). The
	 * adapter is responsible for correlating the eventual reply back to the
	 * backend's own request id.
	 */
	onRequest(cb: (request: AgentRequest) => void): Unsubscribe;
	/** Answer a pending request. `response` is backend-shaped; null declines. */
	reply(requestId: string, response: unknown): Promise<void>;

	/** Fires when a turn fails in a way the transcript does not convey. */
	onError(cb: (message: string) => void): Unsubscribe;

	// -- session controls ---------------------------------------------------
	setModel(model: string): Promise<void>;
	listModels(): Promise<ModelInfo[]>;
}

/**
 * Adapters are constructed, then started. Keeping construction synchronous and
 * side-effect-free is what lets tests drive an adapter over a recorded fixture
 * without spawning anything.
 */
export interface AdapterFactory {
	create(ref: SessionRef): BackendAdapter;
}
