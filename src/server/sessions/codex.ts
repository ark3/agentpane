/**
 * Codex session file -> SessionSummary, reading only what enumeration needs.
 *
 * Header: HANDOFF finding 18/20 -- current files start
 * `{"type":"session_meta","payload":{id,cwd,timestamp,...}}`; 5 of 583 files
 * on this machine use an older bare `{id,timestamp}` header with no `cwd`.
 * Both are handled; anything else is bucketed unknown rather than thrown.
 *
 * Subagent rollouts are listed like any other session (D19): a spawned thread
 * writes its own rollout, and nothing here filters it out. The marker is
 * `session_meta.payload.thread_source === "subagent"` -- census on the home
 * server 2026-09-11, over the 72 September rollouts written by `codex-cli`
 * 0.150.1 through 0.154.0: 45 carry it. `forked_from_id` is NOT a reliable
 * second marker; only 39 of those 45 carry one, and all six without it were
 * written by 0.154.0, which emits it for 5 of its 11 subagent rollouts.
 * The parent's transcript links to the child by id, and that link resolves
 * through `getSession` and the preview route, which locate by filename and so
 * would keep reaching a child even if the listing ever hid one.
 *
 * Preview: see SYNTHETIC_USER_PREFIXES below -- this is the one place this
 * module goes beyond what DESIGN/HANDOFF describe, because "first user
 * message" turned out not to mean what it sounds like for Codex. Flagged in
 * the agent report.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Stats } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FileChange } from "../../../resources/codex-protocol/FileChange";
import type { ParsedCommand } from "../../../resources/codex-protocol/ParsedCommand";
import type { SessionPreviewTurn, SessionSummary } from "../../shared/protocol.ts";
import { mapItem } from "../adapters/codex/mapping.ts";
import type { CodexItem, MessagePhase, ThreadItem, UserInput } from "../adapters/codex/protocol.ts";
import type { CommandAction } from "../../../resources/codex-protocol/v2/CommandAction";
import { readLinesLfOnly } from "./line-reader.ts";
import { previewTurnsFromMessages, storedAgentMessage } from "./preview-message.ts";
import { trimPreview } from "./text.ts";
import { fileMatchesThreadId, findJsonlFiles } from "./walk.ts";

/**
 * Codex (and whatever harness/plugin set is active) injects wrapper content
 * into the first several "user"-role turns of nearly every real session:
 * AGENTS.md dumps, `<environment_context>`, permission/apps/skills
 * instructions, `<recommended_plugins>`, project `<user_instructions>`. None
 * of it is something a human typed.
 *
 * Census on this machine (2026-08-11, 583 files): a random sample of 20
 * sessions found the first user-role item was *entirely* synthetic wrapper
 * content in 18/20 of them; the real first human message was typically the
 * second or third user-role item, several hundred to several thousand bytes
 * in. Naively using "the first user message" as DESIGN/HANDOFF describe it
 * would show a system-prompt dump as the preview almost every time.
 *
 * This prefix list is therefore a heuristic, not a documented contract, and
 * will need to grow as injected wrapper content drifts -- same spirit as the
 * header-format drift D9 already calls out for the session header itself.
 *
 * It serves enumeration and the transcript preview of a rollout that takes
 * the fallback. One that takes the item path draws only what the user typed
 * and never reaches this list (`extractStoreTurn`).
 */
const SYNTHETIC_USER_PREFIXES = [
	"<environment_context>",
	"<permissions instructions>",
	"<apps_instructions>",
	"<skills_instructions>",
	"<user_instructions>",
	"<recommended_plugins>",
	"# AGENTS.md instructions",
	"<INSTRUCTIONS>",
];

function isSyntheticBlock(text: string): boolean {
	const trimmed = text.trimStart();
	return SYNTHETIC_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

interface ParsedHeader {
	id: string | null;
	cwd: string | null;
	createdAt: string | null;
}

const EMPTY_HEADER: ParsedHeader = { id: null, cwd: null, createdAt: null };

function parseHeader(line: string): ParsedHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return EMPTY_HEADER;
	}
	if (typeof parsed !== "object" || parsed === null) return EMPTY_HEADER;
	const rec = parsed as Record<string, unknown>;

	// Current format.
	if (rec.type === "session_meta" && typeof rec.payload === "object" && rec.payload !== null) {
		const payload = rec.payload as Record<string, unknown>;
		return {
			id: typeof payload.id === "string" ? payload.id : null,
			cwd: typeof payload.cwd === "string" ? payload.cwd : null,
			createdAt: typeof payload.timestamp === "string" ? payload.timestamp : null,
		};
	}

	// Drifted older format: bare {id,timestamp}, no "type", no cwd.
	if (typeof rec.id === "string") {
		return {
			id: rec.id,
			cwd: null,
			createdAt: typeof rec.timestamp === "string" ? rec.timestamp : null,
		};
	}

	// Unrecognised header shape -- never throw; caller falls back to filename.
	return EMPTY_HEADER;
}

/** Text blocks of a user-role message, in either the current or old shape. */
function extractUserMessageTexts(line: string): string[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Record<string, unknown>;

	let role: unknown;
	let content: unknown;
	if (rec.type === "response_item" && typeof rec.payload === "object" && rec.payload !== null) {
		const payload = rec.payload as Record<string, unknown>;
		if (payload.type === "message") {
			role = payload.role;
			content = payload.content;
		}
	} else if (rec.type === "message") {
		// Drifted older format: flat {type:"message",role,content}.
		role = rec.role;
		content = rec.content;
	}

	if (role !== "user" || !Array.isArray(content)) return null;

	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const text = (block as Record<string, unknown>).text;
			if (typeof text === "string") texts.push(text);
		}
	}
	return texts;
}

function derivePreview(texts: string[]): string | null {
	const kept = texts.filter((t) => t.trim().length > 0 && !isSyntheticBlock(t));
	const joined = kept.join(" ").trim();
	return joined.length > 0 ? trimPreview(joined) : null;
}

/** Fallback id when the header carries none: pull the uuid out of the filename. */
function idFromFilename(filePath: string): string {
	const base = filePath.slice(filePath.lastIndexOf("/") + 1);
	const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
	return match?.[1] ?? filePath;
}

export async function parseCodexSession(filePath: string, stat: Stats): Promise<SessionSummary> {
	let header: ParsedHeader = EMPTY_HEADER;
	let preview: string | null = null;

	try {
		let lineNo = 0;
		for await (const line of readLinesLfOnly(filePath)) {
			lineNo++;
			if (lineNo === 1) {
				header = parseHeader(line);
				continue;
			}
			const texts = extractUserMessageTexts(line);
			if (!texts) continue;
			const candidate = derivePreview(texts);
			if (candidate) {
				preview = candidate;
				break;
			}
		}
	} catch {
		// Unreadable file (deleted mid-walk, permission error, ...). Enumeration
		// tolerates a single bad file; fall through with whatever was found.
	}

	return {
		ref: { backend: "codex", id: header.id ?? idFromFilename(filePath) },
		cwd: header.cwd,
		preview,
		createdAt: header.createdAt,
		updatedAt: stat.mtime.toISOString(),
		status: "detached",
		isStreaming: false,
		onDisk: true,
	};
}

/** The rollout file of a Codex thread, or undefined when the store has none. */
export type CodexRolloutLocator = (threadId: string) => string | undefined;

/**
 * The full transcript of a stored Codex session for the read-only preview
 * (OW-38), drawn by the live mapper where the rollout allows; see
 * `projectRollout` for the two paths.
 *
 * A fork's rollout may hold none of the history it inherited, which then lives
 * in another rollout its header names; `locate` finds that file, and the
 * inherited turns are drawn ahead of the fork's own. See `historyBase`.
 */
export async function extractCodexPreviewTurns(
	filePath: string,
	locate: CodexRolloutLocator,
): Promise<SessionPreviewTurn[]> {
	const turns: SessionPreviewTurn[] = [];
	const context: PreviewContext = { toolNames: new Map(), tokensBefore: 0 };
	await projectRollout(filePath, Infinity, locate, context, turns);
	return turns;
}

/** The model and effort one stored `turn_context` record names; either may be absent from it. */
export interface CodexTurnSettings {
	model: string | null;
	effort: string | null;
}

/**
 * The model and effort the last turn in a stored thread's history ran at, or
 * null when the store holds no rollout for the thread or no turn in it (D23).
 *
 * Every turn writes a `turn_context` record carrying both, as the turn ran
 * them: a `turn/start` override lands there and nowhere a notification
 * reports (`docs/MANUAL_TESTING.md`, OW-kokalo, `codex-cli` 0.156.0). A fork
 * whose rollout holds none of its inherited history is read through its
 * `history_base`, exactly as the preview reads it, so a fork with no turn of
 * its own yet answers with the last turn it kept of its parent's.
 */
export async function readCodexLastTurnSettings(
	root: string,
	threadId: string,
): Promise<CodexTurnSettings | null> {
	const files = await findJsonlFiles(root);
	const locate: CodexRolloutLocator = (id) => files.find((file) => fileMatchesThreadId(file, id));
	const file = locate(threadId);
	// A rollout that vanishes or will not read mid-walk names nothing, as in enumeration.
	return file ? lastTurnSettings(file, Infinity, locate).catch(() => null) : null;
}

/** `projectRollout`'s walk, keeping only the last `turn_context` below `endOrdinal`. */
async function lastTurnSettings(
	filePath: string,
	endOrdinal: number,
	locate: CodexRolloutLocator,
): Promise<CodexTurnSettings | null> {
	let last: CodexTurnSettings | null = null;
	let lineNo = 0;
	let ownLines = Infinity;
	for await (const line of readLinesLfOnly(filePath, { maxLines: Infinity, maxBytes: Infinity })) {
		lineNo++;
		if (lineNo === 1) {
			const base = historyBase(line);
			const baseFile = base ? locate(base.threadId) : undefined;
			if (base && baseFile) last = await lastTurnSettings(baseFile, base.endOrdinal, locate);
			ownLines = endOrdinal - (base?.endOrdinal ?? 0);
			continue;
		}
		if (lineNo > ownLines) break;
		// Most lines are large items; only a line naming the type is parsed.
		if (!line.includes('"turn_context"')) continue;
		last = turnSettings(line) ?? last;
	}
	return last;
}

function turnSettings(line: string): CodexTurnSettings | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	const rec = parsed as { type?: unknown; payload?: { model?: unknown; effort?: unknown } } | null;
	if (rec?.type !== "turn_context" || typeof rec.payload !== "object" || rec.payload === null) return null;
	const { model, effort } = rec.payload;
	return {
		model: typeof model === "string" ? model : null,
		effort: typeof effort === "string" ? effort : null,
	};
}

/**
 * Where a fork's inherited history ends, from its `session_meta` (OW-buligi).
 *
 * As of `codex-cli` 0.154.0 a fork made by `thread/fork` writes a rollout that
 * holds only its own records; the header's `history_base` names the thread
 * whose rollout holds the rest, as `{thread_id, end_ordinal_exclusive,
 * end_byte_offset}`. The one earlier fork captured, `resources/fixtures/codex/
 * fork.jsonl` on 0.147.0, copies its parent's records into its own file
 * instead, after a second `session_meta`, and so draws whole with no base to
 * follow; no version between the two has been looked at.
 *
 * The ordinal counts records over the named thread's whole history, not its
 * file: a thread's own line n (header first, from 0) is ordinal n plus
 * whatever that thread itself inherited. Measured on 0.156.0 with
 * `resources/probes/codex_fork_history_probe.py`: a fork of a fork taken after
 * the first fork's own turn named that fork at ordinal 27, which is the 13
 * records it inherited plus the 14 lines of its own file through that turn's
 * `task_complete`, and whose byte offset ended at exactly that 14th line. The
 * byte offset is file-local and would do as well; the ordinal is used because
 * the line reader counts lines, not bytes. A fork of a fork cut inside the
 * first fork's inherited history names the grandparent instead (0.154.0,
 * 2026-09-15 on the home server), which is why the base, not
 * `forked_from_id`, is followed. Every cut measured fell between turns, at a
 * `task_complete` or at a `thread_settings_applied` just after one, since
 * `lastTurnId` forks whole turns. See `docs/MANUAL_TESTING.md`, "A Codex
 * fork's rollout names where its inherited history ends (OW-buligi)".
 *
 * A subagent's rollout carries `forked_from_id` but, across the 43 on the home
 * server written by 0.150.1 through 0.154.0, never `history_base`: its file
 * repeats its parent's records inline, like the 0.147.0 fork. Following
 * `forked_from_id` would draw that history twice.
 *
 * Neither kind repeats its parent's item records (OW-luvema; home server,
 * 2026-10-01), so the cut serves a rollout drawn from those unchanged. None of
 * the 19 forks there with a `history_base` (0.154.0 and 0.156.0) shares an
 * item id with its base, nor any of the 26 subagents written by 0.153.0
 * through 0.154.0 that name their parent in `forked_from_id`: what such a
 * subagent copies inline is some of the parent's `response_item` messages.
 * Of the 32 subagents from those versions, the 10 that store collab calls
 * take the fallback (`extractStoreTurn`) and draw that copy as before; the
 * other 22 draw from their own item records and show none of it, and 17 of
 * them so lose a user message the preview drew before. The ten 0.150.1
 * subagents that carry item records carry only copies of their parent's
 * `SubAgentActivity`, and draw from their `response_item`s as before.
 */
function historyBase(header: string): { threadId: string; endOrdinal: number } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(header);
	} catch {
		return null;
	}
	const payload = (parsed as { payload?: { history_base?: unknown } } | null)?.payload;
	const base = payload?.history_base as Record<string, unknown> | null | undefined;
	if (typeof base?.thread_id !== "string" || typeof base.end_ordinal_exclusive !== "number") return null;
	return { threadId: base.thread_id, endOrdinal: base.end_ordinal_exclusive };
}

/**
 * Projects `filePath`'s records below `endOrdinal` onto `turns`, the history it
 * inherited first. When the base's rollout is not in the store the inherited
 * turns are simply missing, and the fork draws only its own.
 *
 * Both of `extractStoreTurn`'s paths are drawn as the file is read, and the
 * file picks one at its end, so the choice is per file: each rollout a fork's
 * history spans makes its own. Compaction markers belong to both.
 */
async function projectRollout(
	filePath: string,
	endOrdinal: number,
	locate: CodexRolloutLocator,
	context: PreviewContext,
	turns: SessionPreviewTurn[],
): Promise<void> {
	let lineNo = 0;
	let ownLines = Infinity;
	const fromItems: SessionPreviewTurn[] = [];
	const fromStore: SessionPreviewTurn[] = [];
	let carriesItems = false;
	let storesCollabCalls = false;
	// Unbounded: unlike enumeration, the preview must reach the real end of the
	// file (attaching already shows the whole transcript, so the preview
	// stopping early at the enumeration caps would be a visible regression).
	for await (const line of readLinesLfOnly(filePath, { maxLines: Infinity, maxBytes: Infinity })) {
		lineNo++;
		if (lineNo === 1) {
			const base = historyBase(line);
			const baseFile = base ? locate(base.threadId) : undefined;
			if (base && baseFile) await projectRollout(baseFile, base.endOrdinal, locate, context, turns);
			ownLines = endOrdinal - (base?.endOrdinal ?? 0);
			continue;
		}
		if (lineNo > ownLines) break;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const rec = parsed as Record<string, unknown>;

		const compactionTurn = compactionTurnFor(rec, context);
		if (compactionTurn) {
			fromItems.push(compactionTurn);
			fromStore.push(compactionTurn);
			continue;
		}
		const payload = rec.payload as { type?: unknown; item: RolloutItem; started_at_ms: number } | undefined;
		if (rec.type === "event_msg" && payload?.type === "item_completed") {
			const item = threadItem(payload.item);
			if (item) {
				carriesItems = true;
				fromItems.push(...previewTurnsFromMessages(mappedMessages(item, payload.started_at_ms)));
			}
			continue;
		}
		if (rec.type === "response_item" && payload?.type === "function_call") {
			storesCollabCalls ||= (rec.payload as { namespace?: unknown }).namespace === "collaboration";
		}
		const turn = extractStoreTurn(rec, context);
		if (turn) fromStore.push(turn);
	}
	turns.push(...(carriesItems && !storesCollabCalls ? fromItems : fromStore));
}

/** What `mapItem` draws for one completed item, as the reducer flattens it. */
function mappedMessages(item: ThreadItem, timestamp: number): AgentMessage[] {
	const mapped = mapItem(item, { ...CODEX_PREVIEW_IDENTITY, timestamp, effort: null, completed: true, tokensBefore: 0 });
	if (mapped.kind === "none") return [];
	if (mapped.kind === "single") return [mapped.message];
	return mapped.result ? [mapped.call, mapped.result] : [mapped.call];
}

/**
 * An `item_completed` record's item as the rollout serializes it. Nothing in
 * `resources/codex-protocol/` types the item itself -- the app-server bindings
 * there type the camelCase `ThreadItem` -- so this is read off the seven
 * `resources/fixtures/codex/*.rollout.jsonl` (`codex-cli 0.157.1`) and the
 * home server's rollouts from 0.147.0 through 0.156.0. Only parts have
 * bindings: `FileChange`, one entry of a file change's path-keyed `changes`,
 * and `ParsedCommand`, one entry of a command's `parsed_cmd`.
 */
type RolloutItem =
	| { type: "UserMessage"; id: string; content: { type: string }[] }
	| { type: "AgentMessage"; id: string; content: { type: string; text: string }[]; phase: MessagePhase | null }
	| { type: "Reasoning"; id: string; summary_text: string[]; raw_content: string[] }
	| { type: "Plan"; id: string; text: string }
	| {
		type: "CommandExecution";
		id: string;
		command: string[];
		cwd: string;
		parsed_cmd: ParsedCommand[];
		process_id: string | null;
		source: string;
		status: string;
		aggregated_output: string;
		exit_code: number | null;
		duration: { secs: number; nanos: number } | null;
	}
	| { type: "FileChange"; id: string; changes: Record<string, FileChange>; status: string }
	| {
		type: "CollabAgentToolCall";
		id: string;
		tool: string;
		status: string;
		sender_thread_id: string;
		receiver_thread_ids: string[];
		prompt?: string | null;
		model?: string | null;
		reasoning_effort?: CodexItem<"collabAgentToolCall">["reasoningEffort"];
		/** A bare status (`"not_found"`), or a status keyed to its message (`{"completed": "Hello"}`). */
		agents_states: Record<string, string | Record<string, string | null>>;
	};

/** `unified_exec_startup` -> `unifiedExecStartup`: the rollout's enum values in the bindings' case. */
function camel<T extends string>(value: string): T {
	return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) as T;
}

/**
 * argv as one command line, as the live `commandExecution.command` reads: a
 * port of `quote` from the Rust `shlex` crate 1.3.0, joined by spaces. Each
 * word is cut into the longest chunks one strategy can carry -- bare, single
 * quoted, or double quoted with `"` and `\` escaped -- preferring them in that
 * order. Pinned against the live strings of `tool-read`, `tool-edit`,
 * `collab-multi` and `long-shell` in `resources/fixtures/codex/`.
 */
function shellJoin(argv: string[]): string {
	return argv.map(shellQuote).join(" ");
}

const BARE = 1;
const SINGLE = 2;
const DOUBLE = 4;

function shellQuote(word: string): string {
	if (word === "") return "''";
	let out = "";
	let rest = word;
	while (rest) {
		// `^` is single-quoted only right after the opening quote (a Bash bug).
		let ok = rest[0] === "^" ? SINGLE : BARE | SINGLE | DOUBLE;
		let length = rest[0] === "^" ? 1 : 0;
		for (; length < rest.length; length++) {
			const c = rest[length]!;
			let next = ok;
			if (!/^[+\-./:@\]_0-9A-Za-z]$/.test(c)) next &= ~BARE;
			if (c === "'" || c === "^" || c === "\\") next &= ~SINGLE;
			if (c === "`" || c === "$" || c === "!" || c === "^") next &= ~DOUBLE;
			if (next === 0) break;
			ok = next;
		}
		const chunk = rest.slice(0, length);
		rest = rest.slice(length);
		out += ok & BARE ? chunk : ok & SINGLE ? `'${chunk}'` : `"${chunk.replace(/["\\]/g, "\\$&")}"`;
	}
	return out;
}

/**
 * The `ThreadItem` `mapItem` takes for a rollout item, or null for a kind not
 * translated here; see `extractStoreTurn` for which those are.
 */
function threadItem(item: RolloutItem): ThreadItem | null {
	const { id } = item;
	switch (item.type) {
		case "UserMessage": {
			// Only text input has been seen on disk; see `extractStoreTurn`.
			const content = item.content.filter((input) => input.type === "text") as UserInput[];
			return { type: "userMessage", id, clientId: null, content };
		}
		case "AgentMessage": {
			const text = item.content.map((part) => part.text).join("");
			return { type: "agentMessage", id, text, phase: item.phase, memoryCitation: null, delivery: null, questions: null };
		}
		case "Reasoning":
			return { type: "reasoning", id, summary: item.summary_text, content: item.raw_content };
		case "Plan":
			return { type: "plan", id, text: item.text };
		case "CommandExecution": {
			const { duration } = item;
			return {
				type: "commandExecution",
				id,
				pluginId: null,
				scriptPath: null,
				command: shellJoin(item.command),
				cwd: fileURLToPath(item.cwd),
				processId: item.process_id,
				source: camel(item.source),
				status: camel(item.status),
				commandActions: item.parsed_cmd.map(({ cmd, ...action }) => ({ ...action, type: camel(action.type), command: cmd }) as CommandAction),
				aggregatedOutput: item.aggregated_output,
				exitCode: item.exit_code,
				durationMs: duration ? Math.trunc(duration.secs * 1000 + duration.nanos / 1e6) : null,
			};
		}
		case "FileChange":
			return {
				type: "fileChange",
				id,
				changes: Object.entries(item.changes).map(([path, change]) =>
					change.type === "update"
						? { path, kind: { type: "update", move_path: change.move_path }, diff: change.unified_diff }
						: { path, kind: { type: change.type }, diff: change.content }
				),
				status: camel(item.status),
			};
		case "CollabAgentToolCall":
			return {
				type: "collabAgentToolCall",
				id,
				tool: camel(item.tool),
				status: camel(item.status),
				senderThreadId: item.sender_thread_id,
				receiverThreadIds: item.receiver_thread_ids,
				prompt: item.prompt ?? null,
				model: item.model ?? null,
				reasoningEffort: item.reasoning_effort ?? null,
				agentsStates: Object.fromEntries(
					Object.entries(item.agents_states).map(([thread, state]) => {
						const [status, message] = typeof state === "string" ? [state, null] : Object.entries(state)[0]!;
						return [thread, { status: camel(status), message: message ?? null }];
					}),
				),
			};
		default:
			return null;
	}
}

/**
 * One transcript message from a Codex store line: the preview's fallback path.
 *
 * The preview has two. A rollout that carries `event_msg` records of type
 * `item_completed` -- the rollout's copy of each item the thread's live stream
 * completed, same ids, same order (`docs/MANUAL_TESTING.md`, "Codex fixtures
 * that keep their rollout (OW-zadupu)", `codex-cli 0.157.1`) -- can draw its
 * items from those alone: `threadItem` translates each into the `ThreadItem`
 * the live `mapItem` takes, so live and preview have one mapper (OW-luvema).
 * A rollout with none, or whose records are not a full copy, comes here
 * instead, and this maps its Responses API `response_item` payloads directly,
 * with the differences from live that `codex-conformance.test.ts` once listed
 * accepted for those files as a first cut: injected user-role messages that
 * `SYNTHETIC_USER_PREFIXES` misses, an `exec` script for every tool the model
 * ran that way, and `isError: false` on every result.
 *
 * A rollout takes the item path when one of its records translates and it
 * stores no collab call as a `function_call` in the `collaboration`
 * namespace. Both conditions are measured, on the home server's
 * `~/.codex/sessions` on 2026-10-01:
 *
 * - On `codex-cli` 0.150.1, 17 rollouts carry `item_completed` records of
 *   `SubAgentActivity` alone -- seven `vscode` threads that spawned subagents,
 *   and ten subagents whose records are their parent's, copied inline -- and
 *   hold every real item as a `response_item` or legacy `event_msg`.
 * - From 0.150.1 through 0.154.0, 39 rollouts store collab calls that way
 *   (507 calls: 14 rollouts on 0.150.1, 7 on 0.153.0, 9 on 0.153.4, 9 on
 *   0.154.0), and their item records are not a full copy. Spawns,
 *   `send_message`, `followup_task`, `list_agents` and `interrupt_agent` have
 *   no record at all, and all 179 `CollabAgentToolCall` records there are
 *   `wait`s naming no child and no state. Drawn from those records, a parent
 *   would lose its spawns and draw each wait as an empty `subagent` card. The
 *   0.157.1 captures store collab calls as `exec` scripts instead, and their
 *   records are whole.
 *
 * So, of the 119 rollouts there, 50 take the item path: 1 of 1 on 0.147.0, 2
 * of 34 on 0.150.1, 8 of 15 on 0.153.0, 11 of 20 on 0.153.4, 23 of 44 on
 * 0.154.0 (12 of the other 21 hold no turn, and draw only what their
 * `history_base` names), and 5 of 5 on 0.156.0.
 *
 * Kinds the translation does not know -- `SubAgentActivity`, which `mapItem`
 * draws nothing for either; `ContextCompaction`, whose marker comes from the
 * `compacted` record (`compactionTurnFor`); and `WebSearch`, `McpToolCall`,
 * `DynamicToolCall` and image generation, which have no capture yet -- are
 * skipped and draw nothing. User input other than text is dropped the same
 * way: none has been seen in an item record.
 */
function extractStoreTurn(
	rec: Record<string, unknown>,
	context: PreviewContext,
): SessionPreviewTurn | null {
	const { toolNames } = context;
	let payload: Record<string, unknown> | null = null;
	if (rec.type === "response_item" && typeof rec.payload === "object" && rec.payload !== null) {
		payload = rec.payload as Record<string, unknown>;
	} else if (rec.type === "message") {
		payload = rec;
	}
	if (!payload) return null;
	const timestamp = typeof rec.timestamp === "string" ? rec.timestamp : undefined;

	if (payload.type === "message") {
		const role = payload.role;
		if ((role !== "user" && role !== "assistant") || !Array.isArray(payload.content)) return null;
		const content = payload.content
			.map(codexMessageBlock)
			.filter((block): block is Record<string, unknown> => block !== null)
			.filter((block) => role !== "user" || block.type !== "text" || !isSyntheticBlock(block.text as string));
		if (content.length === 0) return null;
		return storedAgentMessage(
			{ role, content },
			timestamp,
			CODEX_PREVIEW_IDENTITY,
		);
	}

	if (payload.type === "reasoning") {
		const thinking = [...textParts(payload.summary), ...textParts(payload.content)]
			.map((part) => part.trim())
			.filter(Boolean)
			.join("\n\n");
		if (!thinking) return null;
		return assistantPreview([{ type: "thinking", thinking }], timestamp);
	}

	if (payload.type === "function_call" || payload.type === "custom_tool_call") {
		if (typeof payload.call_id !== "string" || typeof payload.name !== "string") return null;
		const name = typeof payload.namespace === "string"
			? `${payload.namespace}__${payload.name}`
			: payload.name;
		const rawArguments = payload.type === "function_call" ? payload.arguments : payload.input;
		// A shell run is `commandExecution` on the live wire, which
		// `adapters/codex/mapping.ts` already names `bash`, but the rollout on
		// disk stores it as either of two shapes: a `function_call` named
		// `exec_command` with JSON arguments, or a `custom_tool_call` named
		// `exec` whose input is a script calling `tools.exec_command({...})`.
		// Measured 2026-09-22 on `codex-cli` 0.155.1 (`docs/MANUAL_TESTING.md`,
		// "A Codex shell run is `commandExecution` live and `exec` or
		// `exec_command` on disk (OW-jakahe)"). Both fold to `bash` here so the
		// preview and the live transcript name one run the same way.
		const shell = name === "exec_command" && payload.type === "function_call"
			? shellArguments(parseArguments(rawArguments))
			: name === "exec" && payload.type === "custom_tool_call"
				? execScriptArguments(rawArguments)
				: null;
		if (shell) {
			toolNames.set(payload.call_id, "bash");
			return assistantPreview([
				{ type: "toolCall", id: payload.call_id, name: "bash", arguments: shell },
			], timestamp, "toolUse");
		}
		toolNames.set(payload.call_id, name);
		return assistantPreview([
			{
				type: "toolCall",
				id: payload.call_id,
				name,
				arguments: parseArguments(rawArguments),
			},
		], timestamp, "toolUse");
	}

	if (payload.type === "local_shell_call") {
		const id = typeof payload.call_id === "string"
			? payload.call_id
			: typeof payload.id === "string"
				? payload.id
				: null;
		if (!id) return null;
		const action = typeof payload.action === "object" && payload.action !== null
			? payload.action as Record<string, unknown>
			: {};
		const command = Array.isArray(action.command)
			? action.command.filter((part): part is string => typeof part === "string").join(" ")
			: "";
		toolNames.set(id, "bash");
		return assistantPreview([
			{
				type: "toolCall",
				id,
				name: "bash",
				arguments: {
					command,
					cwd: typeof action.working_directory === "string" ? action.working_directory : null,
				},
			},
		], timestamp, "toolUse");
	}

	if (payload.type === "web_search_call") {
		if (typeof payload.id !== "string") return null;
		toolNames.set(payload.id, "web_search");
		return assistantPreview([
			{
				type: "toolCall",
				id: payload.id,
				name: "web_search",
				arguments: typeof payload.action === "object" && payload.action !== null
					? payload.action as Record<string, unknown>
					: {},
			},
		], timestamp, "toolUse");
	}

	if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
		if (typeof payload.call_id !== "string") return null;
		const name = toolNames.get(payload.call_id) ??
			(typeof payload.name === "string" ? payload.name : "");
		return storedAgentMessage(
			{
				role: "toolResult",
				toolCallId: payload.call_id,
				toolName: name,
				content: outputContent(payload.output),
				// The stored output says nothing about failure; a rollout that takes
				// the item path reads it off the item instead (`extractStoreTurn`).
				isError: false,
			},
			timestamp,
			CODEX_PREVIEW_IDENTITY,
		);
	}

	return null;
}

/**
 * State `extractStoreTurn` carries across lines: tool names by call id, and the
 * standing context size for the next compaction marker.
 */
interface PreviewContext {
	toolNames: Map<string, string>;
	tokensBefore: number;
}

/**
 * Compaction on disk, and the pre-compaction token figure that goes on its
 * marker (OW-bisubi). Two record types matter, neither of them a
 * `response_item`:
 *
 * - `{"type":"compacted","payload":{...}}` is the compaction itself, one per
 *   event. Its payload has no `type` field at all; the keys are `message`,
 *   `replacement_history`, `window_number`, `first_window_id`,
 *   `previous_window_id`, `window_id` on `codex-cli` 0.147.0 and 0.150.1, plus
 *   `compaction_response_id`, `guardian_history` and
 *   `latest_token_usage_record` on 0.153.0. 0.154.0 is unmeasured -- it wrote
 *   no compaction in any rollout on the home server as of 2026-09-13.
 *   0.150.1 also writes an `event_msg`/`context_compacted` a few milliseconds
 *   later; matching that too would draw two markers for one compaction, so
 *   only `compacted` is matched.
 * - `{"type":"event_msg","payload":{"type":"token_count","info":{...}}}`
 *   carries the figure. `tokensBefore` is `info.last_token_usage.total_tokens`
 *   of the last such record strictly before the `compacted` one, which is the
 *   disk analogue of the live path's sample at `item/started
 *   contextCompaction` (OW-kelomi, `adapters/codex/reducer.ts`) and has to mean
 *   the same thing, because both markers can be on one screen. Those two
 *   sampling points are not the same moment -- live samples before the
 *   compaction runs, and the `compacted` record is written at its completion --
 *   and they agree only because the intermediate updates the live path
 *   deliberately refuses (16304 -> 14692 -> 4844 in `docs/MANUAL_TESTING.md`)
 *   are not persisted as `token_count` records. Measured so on 0.150.1 and
 *   0.153.0; a release that persists them would report the post-compaction
 *   size here under a label that says "before".
 *
 * Two fields deliberately not used. `info.total_token_usage` is cumulative for
 * the thread and climbs straight through a compaction (0.150.1: 11095489 on
 * both sides), which is why the live path refused its `ThreadTokenUsage.total`
 * counterpart. A top-level `token_usage_record` sits nearer the `compacted`
 * record on 0.153.0 but reports the compaction call's own usage, not the
 * standing context -- the disk analogue of the later sample the live path
 * skips. Hence the filter to `event_msg`/`token_count`.
 *
 * Where no figure precedes the `compacted` record the marker reports 0, which
 * is what the single 0.147.0 rollout on the home server does: the one
 * `token_count` before its compaction carries `info: null`. That version does
 * write a populated `info` on the two `token_count` records after it, so the
 * null is not a property of the version so much as of that point in the file.
 *
 * A figure is *not* carried across a compaction: it is cleared as the marker is
 * drawn, so a second compaction with no `token_count` between reports nothing
 * rather than borrowing the first's figure. Same reason the live path keys its
 * figure by item id (`adapters/codex/reducer.ts`). A `token_count` whose `info`
 * is null does not clear it, matching the live path, where `tokenUsage` keeps
 * its last non-null value.
 *
 * The vendored `resources/codex-protocol/ResponseItem.ts` does declare
 * `compaction` and `context_compaction` variants, which is what the arm this
 * replaced matched. They are wire shapes: across the 88 rollouts on the home
 * server on 2026-09-13, no `response_item` payload carries either type, so
 * matching them here drew nothing.
 */
function compactionTurnFor(
	rec: Record<string, unknown>,
	context: PreviewContext,
): SessionPreviewTurn | null {
	const payload = typeof rec.payload === "object" && rec.payload !== null
		? rec.payload as Record<string, unknown>
		: null;

	if (rec.type === "event_msg" && payload?.type === "token_count") {
		const info = typeof payload.info === "object" && payload.info !== null
			? payload.info as Record<string, unknown>
			: null;
		const last = typeof info?.last_token_usage === "object" && info.last_token_usage !== null
			? info.last_token_usage as Record<string, unknown>
			: null;
		if (typeof last?.total_tokens === "number") context.tokensBefore = last.total_tokens;
		return null;
	}

	if (rec.type !== "compacted") return null;
	const timestamp = typeof rec.timestamp === "string" ? rec.timestamp : undefined;
	const tokensBefore = context.tokensBefore;
	context.tokensBefore = 0;
	return {
		role: "compactionSummary",
		// Empty, as the live marker's is. The record's `message` was empty on
		// every rollout read on the home server on 2026-10-01 (`codex-cli`
		// 0.147.0, 0.150.1, 0.153.0 and 0.157.1), and the summary Codex keeps
		// is the encrypted `compaction` item in `replacement_history`, so there
		// is nothing readable to show. Were a readable summary ever to appear,
		// whether the preview may show what live cannot is OW-wapage's question.
		summary: "",
		tokensBefore,
		...(timestamp ? { timestamp } : {}),
	} as SessionPreviewTurn;
}

const CODEX_PREVIEW_IDENTITY = {
	api: "openai-responses",
	provider: "openai",
	model: "codex",
} as const;

function assistantPreview(
	content: Record<string, unknown>[],
	timestamp: string | undefined,
	stopReason: "stop" | "toolUse" = "stop",
): SessionPreviewTurn | null {
	return storedAgentMessage(
		{ role: "assistant", content, stopReason },
		timestamp,
		CODEX_PREVIEW_IDENTITY,
	);
}

function textParts(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((part) => {
		if (typeof part === "string") return [part];
		if (typeof part === "object" && part !== null && typeof (part as Record<string, unknown>).text === "string") {
			return [(part as Record<string, unknown>).text as string];
		}
		return [];
	});
}

function codexMessageBlock(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	const block = value as Record<string, unknown>;
	if (
		(block.type === "input_text" || block.type === "output_text" || block.type === "text") &&
		typeof block.text === "string"
	) {
		return { type: "text", text: block.text };
	}
	if (block.type === "input_image" && typeof block.image_url === "string") {
		return imageBlock(block.image_url);
	}
	if (block.type === "input_audio" && typeof block.audio_url === "string") {
		return { type: "text", text: `[audio: ${block.audio_url}]` };
	}
	return null;
}

function imageBlock(url: string): Record<string, unknown> {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
	return match?.[1] && match[2] !== undefined
		? { type: "image", mimeType: match[1], data: match[2] }
		: { type: "text", text: `[image: ${url}]` };
}

function parseArguments(value: unknown): Record<string, unknown> {
	if (typeof value !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: { value: parsed };
	} catch {
		return { value };
	}
}

/** `{command, cwd}` as the `local_shell_call` branch shapes it, or null without a `cmd`. */
function shellArguments(args: Record<string, unknown>): Record<string, unknown> | null {
	if (typeof args.cmd !== "string") return null;
	return { command: args.cmd, cwd: typeof args.workdir === "string" ? args.workdir : null };
}

/**
 * `cmd` and `workdir` lifted out of a stored `tools.exec_command({...})`
 * script. The key is bare in newer rollouts and double-quoted in older ones;
 * the value is one double-quoted literal with JSON's escapes, so the matched
 * literal decodes with `JSON.parse`.
 *
 * Only the fallback reaches it: a rollout that takes the item path previews
 * the run from its `CommandExecution` record (`extractStoreTurn`).
 */
function execScriptArguments(script: unknown): Record<string, unknown> | null {
	if (typeof script !== "string" || !script.includes("tools.exec_command(")) return null;
	const literal = (key: string): string | null => {
		const match = new RegExp(`(?:^|[{,\\s])"?${key}"?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(script);
		if (!match?.[1]) return null;
		try {
			const value: unknown = JSON.parse(match[1]);
			return typeof value === "string" ? value : null;
		} catch {
			return null;
		}
	};
	const cmd = literal("cmd");
	return cmd === null ? null : { command: cmd, cwd: literal("workdir") };
}

function outputContent(value: unknown): Record<string, unknown>[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return [{ type: "text", text: JSON.stringify(value) }];
	return value.flatMap((part) => {
		if (typeof part !== "object" || part === null) return [];
		const block = part as Record<string, unknown>;
		if (block.type === "input_text" && typeof block.text === "string") {
			return [{ type: "text", text: block.text }];
		}
		if (block.type === "input_image" && typeof block.image_url === "string") {
			return [imageBlock(block.image_url)];
		}
		return [{ type: "text", text: JSON.stringify(block) }];
	});
}
