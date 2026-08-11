/**
 * The wire contract between server and browser.
 *
 * FROZEN INTERFACE (DESIGN D11). Both ends of the transport are ours and are
 * written by different people at different times, so this is the one place
 * DESIGN asks for concreteness rather than judgement. Changing anything here
 * breaks work in flight -- raise it before editing.
 *
 * Shape follows DESIGN D2 (SSE for server->client, REST for client->server)
 * and D3 (the server is authoritative; it sends assembled state, never raw
 * backend protocol events).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Sessions (D9)
// ---------------------------------------------------------------------------

export type BackendId = "pi" | "codex";

/**
 * A session is identified by backend *and* id, because each backend has its
 * own store: Pi's id is a JSONL path, Codex's is a UUIDv7 thread id.
 */
export interface SessionRef {
	backend: BackendId;
	id: string;
}

/**
 * - `virtual`  workspace chosen, nothing on disk yet; materialises on first prompt
 * - `detached` exists in the backend's store, no subprocess running
 * - `attached` live subprocess
 */
export type SessionStatus = "virtual" | "detached" | "attached";

export interface SessionSummary {
	ref: SessionRef;
	/** Absolute workspace path. Null for sessions whose header predates the cwd field. */
	cwd: string | null;
	/** First user message, trimmed for display. Null if not yet determined. */
	preview: string | null;
	/** ISO-8601. Null when the backend's header does not carry one. */
	createdAt: string | null;
	updatedAt: string | null;
	status: SessionStatus;
	/** True while this session's agent is mid-turn. */
	isStreaming: boolean;
}

// ---------------------------------------------------------------------------
// Server-initiated requests (D2a)
// ---------------------------------------------------------------------------

/**
 * The agent is asking the human something and is blocked until answered.
 * Codex sends these as `ServerRequest`; see resources/fixtures/codex/tool-edit.jsonl
 * for a real `item/fileChange/requestApproval`. An unanswered one hangs the turn.
 *
 * `kind` is the backend's own method name, deliberately not normalised -- the
 * renderer dispatches on it and falls back to a generic prompt for unknown kinds,
 * the same principle as D5's default tool card.
 */
export interface AgentRequest {
	requestId: string;
	session: SessionRef;
	kind: string;
	payload: unknown;
}

export interface AgentRequestReply {
	requestId: string;
	/** Backend-shaped response body, or null to decline/cancel. */
	response: unknown;
}

// ---------------------------------------------------------------------------
// SSE: server -> browser
// ---------------------------------------------------------------------------

/**
 * One multiplexed stream for every session (D2: browsers cap ~6 connections
 * per origin and an EventSource holds one permanently, so a stream per session
 * would wall at six).
 *
 * `seq` is monotonic *per session*. A gap means the client missed an update;
 * recovery is to re-subscribe and take a fresh snapshot, which is free on
 * loopback. Snapshots reset the sequence.
 */
export type ServerEvent =
	| {
			type: "snapshot";
			session: SessionRef;
			seq: number;
			messages: AgentMessage[];
			isStreaming: boolean;
	  }
	| {
			/**
			 * Streaming only ever touches the tail, and completed messages are
			 * immutable -- so this is O(1) per token regardless of transcript
			 * length. `index` may equal messages.length to append.
			 */
			type: "upsert";
			session: SessionRef;
			seq: number;
			index: number;
			message: AgentMessage;
	  }
	| { type: "status"; session: SessionRef; seq: number; isStreaming: boolean }
	| { type: "request"; session: SessionRef; seq: number; request: AgentRequest }
	| {
			/** A turn ended in an error the transcript alone would not convey. */
			type: "error";
			session: SessionRef;
			seq: number;
			message: string;
	  }
	/** The session list changed (created, deleted, or newly attached). Refetch it. */
	| { type: "sessions-changed" };

// ---------------------------------------------------------------------------
// REST: browser -> server
// ---------------------------------------------------------------------------

/** GET /api/sessions?cwd=<abs path> -- omit cwd for every session everywhere. */
export interface ListSessionsQuery {
	cwd?: string;
}
export interface ListSessionsResponse {
	sessions: SessionSummary[];
}

/** POST /api/sessions -- creates a `virtual` session; nothing hits disk until the first prompt. */
export interface CreateSessionRequest {
	cwd: string;
	backend: BackendId;
	model?: string;
}
export interface CreateSessionResponse {
	ref: SessionRef;
}

/** POST /api/sessions/:backend/:id/prompt */
export interface PromptRequest {
	text: string;
	images?: { mimeType: string; base64: string }[];
}

/** POST /api/sessions/:backend/:id/fork */
export interface ForkRequest {
	entryId: string;
}
export interface ForkResponse {
	ref: SessionRef;
}

/** GET /api/sessions/:backend/:id/fork-points */
export interface ForkPoint {
	id: string;
	text: string;
}
export interface ForkPointsResponse {
	points: ForkPoint[];
}

/** POST /api/sessions/:backend/:id/model */
export interface SetModelRequest {
	model: string;
}

/** GET /api/models?backend=pi|codex */
export interface ModelInfo {
	id: string;
	label: string;
}
export interface ModelsResponse {
	models: ModelInfo[];
}

/** Every non-2xx response body. */
export interface ApiError {
	error: string;
	detail?: string;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Single source of truth for paths, so client and server cannot drift.
 * Loopback only, no auth layer (D8).
 */
export const ROUTES = {
	events: "/api/events",
	sessions: "/api/sessions",
	models: "/api/models",
	session: (ref: SessionRef) => `/api/sessions/${ref.backend}/${encodeURIComponent(ref.id)}`,
	prompt: (ref: SessionRef) =>
		`/api/sessions/${ref.backend}/${encodeURIComponent(ref.id)}/prompt`,
	abort: (ref: SessionRef) => `/api/sessions/${ref.backend}/${encodeURIComponent(ref.id)}/abort`,
	fork: (ref: SessionRef) => `/api/sessions/${ref.backend}/${encodeURIComponent(ref.id)}/fork`,
	forkPoints: (ref: SessionRef) =>
		`/api/sessions/${ref.backend}/${encodeURIComponent(ref.id)}/fork-points`,
	model: (ref: SessionRef) => `/api/sessions/${ref.backend}/${encodeURIComponent(ref.id)}/model`,
	reply: (requestId: string) => `/api/requests/${encodeURIComponent(requestId)}`,
} as const;

export const DEFAULT_PORT = 4173;

/** Equality helper -- SessionRef is used as a map key all over both ends. */
export function sessionKey(ref: SessionRef): string {
	return `${ref.backend}:${ref.id}`;
}
