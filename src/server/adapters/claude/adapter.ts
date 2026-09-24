/**
 * `BackendAdapter` for Claude Code, driving `claude -p` over stream-json in
 * both directions (OW-beripo).
 *
 * This is the shell: spawn, control-channel correlation, and the
 * lifecycle/command surface. The event->message translation lives in
 * `reducer.ts`/`mapping.ts`, which this class drives and never second-guesses.
 *
 * Differences from the Codex shell that are protocol, not preference:
 *
 * - There is no request/response RPC for turns: a turn is admitted by writing
 *   a user-message line to stdin, and only the `result` event ends it. Claude
 *   Code queues a user message written mid-turn as a later turn, and has no
 *   `steer` control subtype (OW-jihete), so `submit()` rejects while the first
 *   turn is active. `compact()` uses the same gate; this adapter never creates
 *   the CLI's queue window itself.
 * - The session id is chosen by US at spawn (`--session-id`, settled live
 *   2026-08-25): a fresh session and a fork both know their id synchronously,
 *   so nothing waits on the `init` event (which only arrives with the first
 *   turn, not at spawn -- settled live the same day).
 * - `fork()` runs nothing. It mints the fork's session id and returns the
 *   `StartOptions` (`forkOf`) that spawn it, leaving this adapter on the parent
 *   with its child, its ref and its in-flight turn intact -- so like Codex, and
 *   unlike Pi, `adapter.ref` does not change and `#adoptRef` no-ops (OW-razoki).
 *   The fork becomes a full session when the manager attaches it: a second
 *   adapter, started with `forkOf`, spawns `--resume <parentId>
 *   --resume-session-at <entryId> --fork-session --session-id <forkId>`.
 *   Respawning THIS child onto the fork was the old shape, and its kill was what
 *   destroyed a parent turn still streaming -- as of `claude 2.1.268` the CLI
 *   itself tolerates two live children on one workspace (MANUAL_TESTING
 *   OW-japuzo). The parent's store
 *   file is untouched and no lineage marker exists on disk (OW-mayuza).
 * - A chosen effort is set on the running process: `setEffort`
 *   sends `apply_flag_settings` with `effortLevel`, and what the CLI then runs
 *   at is read back from `get_settings`'s `applied.effort` -- at start, after
 *   `setEffort` and after `setModel` -- rather than assumed. Measured on the
 *   home server, 2026-09-23, `claude 2.1.280` (docs/MANUAL_TESTING.md,
 *   OW-hokaye): `low` applied at once; a model without effort (haiku)
 *   applied null with the choice still held, and it came back on a
 *   `set_model` to one with effort; an unknown level was accepted and
 *   ignored, which is why nothing here trusts the request alone.
 *   The choice lives in the process's flag-settings layer and dies with
 *   the process.
 *   The store names the effort each turn ran at, but a `--resume` spawn does
 *   not restore it and runs at the settings or model default: a sonnet
 *   session whose turn ran at `low`, and a copy of one whose every stored
 *   turn ran at `max`, each resumed at `high`, and a `--fork-session` spawn
 *   of the latter read `high` too. So a resume and a fork are spawned with
 *   `--effort` at the level the last hydrated assistant message records --
 *   for a fork, the kept prefix's -- because the store, not agentpane, holds
 *   the conversation's effort (D23). A fork before the first message keeps no
 *   prefix, so `fork()` hands it the parent's effort in force, as the last
 *   `get_settings` read it, and it is spawned with `--effort` at that; a
 *   parent whose model has no effort read null and hands over none (D23,
 *   OW-sababi). The flag, not `apply_flag_settings` after attach, because it
 *   is in force from the process's first instant.
 *   Measured on the home server, 2026-09-23, `claude 2.1.280`, no turn
 *   (docs/MANUAL_TESTING.md, OW-nabano): `--effort low` and `--effort max`
 *   on a `--resume` read back `low` and `max` -- `max` too, though it is
 *   session-scoped and named by no settings source -- and `--effort low` on
 *   a `--fork-session` spawn read `low`; `--effort bogus` was ignored rather
 *   than failing the spawn;
 *   and a later `apply_flag_settings` still overrode the flag. The start read
 *   is what makes `getState().effort` true for every path.
 *   The model, unlike the effort, the CLI restores itself, so a resume and a
 *   fork at a real entry are spawned with no `--model`, and the stored model
 *   is only what `getState().model` names first. Measured on the home server,
 *   2026-09-23, `claude 2.1.280`, no turn (docs/MANUAL_TESTING.md,
 *   OW-tebibo): with the settings naming `opus[1m]`, a `--resume` with no
 *   `--model` put in force the `message.model` of the last assistant line
 *   that is not `<synthetic>`, even where that line alone was hand-edited;
 *   a `--fork-session` spawn put in force its kept prefix's, not the file's
 *   last; and a stored `claude-opus-5-5` came back as `claude-opus-5-5[1m]`,
 *   a variant that passing the stored id would drop. A fork's kept prefix
 *   may name a different model from the parent's latest, so the prefix's is
 *   the fork's; the parent's model, which `fork()` hands over, rides the
 *   spawn only when the prefix names none, as does a model given at start
 *   to a resume.
 *   So the start read of `get_settings` renames a stored model by the one in
 *   force: the listed id whose `resolvedModel` it is, never `default`, or the
 *   resolved id itself where no listed id resolves to it. That name is what
 *   `fork()` hands a fork before the first message, a fresh spawn that
 *   carries it as `--model`, so the fork runs what the parent runs, `[1m]`
 *   included. Measured on the home server, 2026-09-23, `claude 2.1.280`, no
 *   turn (docs/MANUAL_TESTING.md, OW-faledu): under settings naming
 *   `opus[1m]`, a fresh `--model claude-opus-5-5` put `claude-opus-5-5` in
 *   force, while `--model opus[1m]` and `--model claude-opus-5-5[1m]` each
 *   put `claude-opus-5-5[1m]` in force under those settings and under
 *   `sonnet`'s; a resumed copy of a store naming `claude-opus-5-5` read
 *   `claude-opus-5-5[1m]`, which `opus[1m]` resolves to, and under `sonnet`'s
 *   settings read `claude-opus-5-5`, which no listed id resolves to and which
 *   a fresh `--model claude-opus-5-5` puts back.
 *   Each turn's `init` event then replaces that name with the id it reports,
 *   which is the model in force with its `[1m]` variant, so what `fork()`
 *   hands over after a turn still puts the variant back, though it may no
 *   longer be a listed id. Measured on the home server, 2026-09-23, `claude
 *   2.1.280` (docs/MANUAL_TESTING.md, OW-lizupu): on a sonnet `[1m]` session,
 *   fresh and resumed, `init` named `claude-sonnet-5[1m]`, as `applied.model`
 *   did, while the assistant event and store line named `claude-sonnet-5`.
 *   Each assistant turn is named with the effort in force when it started,
 *   and a resumed one with the `effort` its store line records.
 * - A session nobody chose a model on still names one before its first turn,
 *   because the clients offer efforts by the session's model and would
 *   otherwise offer none (OW-kakide). The start read of `get_settings` also
 *   carries `applied.model`, the model in force, but as a resolved id
 *   (`claude-opus-5-5[1m]`), not a listed one; `initialize`'s entries each
 *   carry the `resolvedModel` behind their `value`, so the resolved id is
 *   mapped back through them (`listedModelFor`). Measured on the home server,
 *   2026-09-23, `claude 2.1.280`, no turn (docs/MANUAL_TESTING.md, OW-kakide):
 *   `default` resolved to the account's recommended model whatever the
 *   settings named, and a settings `model` of `sonnet` put `claude-sonnet-5`
 *   in force, which maps to `sonnet`. So `default` is named only when it
 *   resolves to the model actually in force, and `--model default` or
 *   `set_model` to it then put that same model in force -- which is what
 *   makes it safe for `fork()` to hand the named model to the fork's spawn.
 *   Only a session with no model yet, or only its store's (above), adopts one
 *   this way, and only the former prefers `default`: this read never
 *   overwrites a model chosen at start or since, though a turn's `init` does
 *   (above).
 * - `onRequest` is inert: sbox's claude profile injects `bypassPermissions`,
 *   and the jail is the confinement boundary -- the same rationale DESIGN
 *   records for Codex's `danger-full-access`. The `can_use_tool` ask only
 *   exists under the undocumented `--permission-prompt-tool stdio` flag, which
 *   this adapter does not pass (shape recorded in fixture
 *   `permission-request.jsonl` for the later item).
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
	AgentRequest,
	AssistantTurn,
	ForkPoint,
	ModelInfo,
	SessionRef,
} from "../../../shared/protocol.ts";
import {
	findClaudeSessionFile,
	readClaudeMessageEntries,
	type ClaudeStoreMessageEntry,
} from "../../sessions/claude.ts";
import type {
	AdapterState,
	AdapterFactory,
	BackendAdapter,
	ForkResult,
	ImageInput,
	StartOptions,
	Unsubscribe,
} from "../types.ts";
import { spawnClaude, type ClaudeProcess, type ClaudeSpawner } from "./process.ts";
import {
	asClaudeEvent,
	buildControlRequestLine,
	buildUserMessageLine,
	isRecord,
	parseClaudeEventLine,
	type ClaudeEvent,
	type ClaudeModelDescriptor,
	type ClaudeUserContent,
} from "./protocol.ts";
import { ClaudeReducer, type ClaudeEffect } from "./reducer.ts";

/**
 * The fork-point id for "before the first message": there is no store entry
 * to name (`--resume-session-at` keeps the named entry, so forking before the
 * FIRST entry has nothing to keep), and `fork()` maps it to a fresh session
 * in the same workspace instead of a resume.
 */
export const CLAUDE_FORK_SESSION_START = "session-start";

const DEFAULT_CLAUDE_ROOT = join(homedir(), ".claude", "projects");
/** The `message.model` of an assistant store line the CLI wrote itself (`lastHydratedAssistant`). */
const SYNTHETIC_MODEL = "<synthetic>";
const TURN_ACTIVE_ERROR = "claude adapter cannot submit while a turn is active";

export interface ClaudeAdapterOptions {
	/** Injected in tests; the default spawns `direnv exec <cwd> sbox -- claude -p ...`. */
	spawn?: ClaudeSpawner;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** Session-id mint, injectable so tests see deterministic refs. */
	newSessionId?: () => string;
	/**
	 * Store access for hydration and fork points, injectable so tests never
	 * touch `~/.claude`. The default locates
	 * `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` by filename match
	 * (the directory munging is lossy) and parses its message lines via
	 * `sessions/claude.ts`.
	 */
	readStoreEntries?: (sessionId: string) => Promise<ClaudeStoreMessageEntry[]>;
	/** Override the store root for the default reader. */
	claudeRoot?: string;
}

interface Ownership {
	proc: ClaudeProcess;
	live: boolean;
}

interface PendingControl {
	resolve: (response: unknown) => void;
	reject: (error: Error) => void;
}

export class ClaudeAdapter implements BackendAdapter {
	private currentRef: SessionRef;
	private readonly options: ClaudeAdapterOptions;
	private readonly reducer: ClaudeReducer;

	private ownership: Ownership | null = null;
	private cwd: string | null = null;
	private model: string | null = null;
	/**
	 * `model` is the store's id, not yet named from what the CLI put in force,
	 * which may carry a `[1m]` variant the store's id lacks (module doc).
	 */
	private modelFromStore = false;
	/** `get_settings`'s `applied.effort` as last read: null for a model without effort (see module doc). */
	private effort: string | null = null;
	private started = false;
	private turnActive = false;
	private disposed = false;
	private disposal: Promise<void> | null = null;

	private controlSeq = 0;
	private readonly controlNamespace = randomUUID();
	private readonly pendingControls = new Map<string, PendingControl>();

	private updateListeners = new Set<(state: AdapterState, changedIndex?: number) => void>();
	private requestListeners = new Set<(request: AgentRequest) => void>();
	private errorListeners = new Set<(message: string) => void>();

	constructor(ref: SessionRef, options: ClaudeAdapterOptions = {}) {
		this.currentRef = ref;
		this.options = options;
		this.reducer = new ClaudeReducer({ now: options.now });
	}

	/**
	 * Not stable. It moves in `start()`, where a `virtual` id becomes the minted
	 * or resumed one, and again if an `init` event names a different
	 * `session_id` -- the CLI is authoritative about its own store, and `init`
	 * arrives with the first turn, so that second move lands well after
	 * `start()` resolved (`handleLine`). `fork()` does NOT move it: the fork is
	 * a second session with an adapter of its own (OW-razoki).
	 */
	get ref(): SessionRef {
		return this.currentRef;
	}

	// -- lifecycle ----------------------------------------------------------

	async start(opts: StartOptions): Promise<void> {
		if (this.disposed) throw new Error("claude adapter disposed");
		if (this.started) throw new Error("claude adapter already started");
		this.started = true;
		this.cwd = opts.cwd;
		if (opts.model) this.model = opts.model;

		if (opts.forkOf) {
			// The fork `fork()` minted: this adapter's ref already carries its id,
			// and the history it starts with is the parent's, truncated inclusive
			// of the cut (OW-mayuza). A cut before the first entry keeps nothing,
			// so it is a fresh session in the same workspace rather than a resume.
			const { parentId, entryId, effort } = opts.forkOf;
			if (entryId === CLAUDE_FORK_SESSION_START) {
				// No kept prefix names an effort, so the parent's rides the spawn (D23).
				await this.attachProcess({
					cwd: opts.cwd,
					sessionId: this.currentRef.id,
					...this.chosenModel(),
					...(effort ? { effort } : {}),
				});
			} else {
				const kept = await this.readForkHistory(parentId, entryId);
				if (this.disposed) throw new Error("claude adapter start aborted: disposed during startup");
				this.applyEffects(this.reducer.hydrate(kept.map((entry) => entry.record)));
				// The CLI restores the kept prefix's model itself (module doc), so it
				// outranks the parent's, which `fork()` hands over and which rides the
				// spawn only for a prefix that names none.
				const stored = this.lastHydratedAssistant();
				if (stored) {
					this.model = stored.model;
					this.modelFromStore = true;
					this.emitUpdate();
				}
				await this.attachProcess({
					cwd: opts.cwd,
					resumeId: parentId,
					forkAtEntryId: entryId,
					sessionId: this.currentRef.id,
					...(stored ? {} : this.chosenModel()),
					...this.storedEffort(),
				});
			}
			if (this.disposed) throw new Error("claude adapter start aborted: disposed during startup");
		} else if (opts.resumeId) {
			// Cold start (D3): the stream will not replay history, so repaint from
			// the store file before spawning. The one await here is also the one
			// place a dispose can land before a child exists.
			const entries = await this.readStore(opts.resumeId);
			if (this.disposed) throw new Error("claude adapter start aborted: disposed during startup");
			this.applyEffects(this.reducer.hydrate(entries.map((entry) => entry.record)));
			this.adoptStoredModel();
			this.currentRef = { backend: "claude", id: opts.resumeId };
			// Only a model given at start rides the spawn: the CLI restores the
			// stored one itself (module doc).
			await this.attachProcess({
				cwd: opts.cwd,
				resumeId: opts.resumeId,
				...(opts.model ? { model: opts.model } : {}),
				...this.storedEffort(),
			});
			if (this.disposed) throw new Error("claude adapter start aborted: disposed during startup");
		} else {
			const sessionId = this.mintSessionId();
			this.currentRef = { backend: "claude", id: sessionId };
			await this.attachProcess({ cwd: opts.cwd, sessionId, ...this.chosenModel() });
			if (this.disposed) throw new Error("claude adapter start aborted: disposed during startup");
		}
		await this.readSettings();
		if (this.disposed) throw new Error("claude adapter start aborted: disposed during startup");
	}

	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.disposed = true;
		this.disposal = this.finishDisposal();
		return this.disposal;
	}

	private async finishDisposal(): Promise<void> {
		const ownership = this.ownership;
		this.ownership = null;
		if (ownership) ownership.live = false;
		this.updateListeners.clear();
		this.requestListeners.clear();
		this.errorListeners.clear();
		this.rejectPendingControls(new Error("claude adapter disposed"));
		await ownership?.proc.kill();
	}

	// -- driving a turn -----------------------------------------------------

	async submit(text: string, images?: ImageInput[]): Promise<void> {
		const proc = this.requireProc();
		if (this.turnActive) throw new Error(TURN_ACTIVE_ERROR);
		const content: ClaudeUserContent[] = [];
		if (text) content.push({ type: "text", text });
		for (const image of images ?? []) {
			content.push({
				type: "image",
				source: { type: "base64", media_type: image.mimeType, data: image.base64 },
			});
		}
		// Admission is the stdin write; the active gate keeps this single-flight.
		proc.write(JSON.stringify(buildUserMessageLine(content)));
		this.turnActive = true;
		this.applyEffects(this.reducer.beginTurn(text, images, this.effort));
	}

	async abort(): Promise<void> {
		if (!this.turnActive) return;
		try {
			await this.sendControl({ subtype: "interrupt" });
		} catch {
			// "Not currently executing" and its kin: the goal state -- no running
			// turn -- already holds, so an errored interrupt is not a failure.
		}
	}

	/**
	 * `/compact` sent as a literal stream-json user message -- the CLI treats it
	 * as the slash command (OW-yilabe, fixture `compact.jsonl`). The reducer
	 * turns the resulting `compact_boundary` + summary into the marker.
	 */
	async compact(): Promise<void> {
		const proc = this.requireProc();
		// A stream-json /compact line is a turn too. Without this shared gate the
		// CLI would queue it behind the live turn, reopening submit's ambiguity.
		if (this.turnActive) throw new Error(TURN_ACTIVE_ERROR);
		this.applyEffects(this.reducer.requestCompaction());
		try {
			proc.write(JSON.stringify(buildUserMessageLine([{ type: "text", text: "/compact" }])));
			this.turnActive = true;
		} catch (error) {
			this.applyEffects(this.reducer.cancelCompaction());
			throw error;
		}
	}

	// -- fork-from-past -----------------------------------------------------

	/**
	 * One fork point per human prompt, labelled with that prompt's text and
	 * carrying that prompt's index in the flat transcript (OW-roveze).
	 * Truncation via `--resume-session-at` is INCLUSIVE of the named entry
	 * (OW-mayuza), so the point for "fork before prompt X" carries the uuid of
	 * the message entry PRECEDING X -- and the first prompt, which nothing
	 * precedes, carries `CLAUDE_FORK_SESSION_START`.
	 *
	 * Which store lines are prompts, and where they land, is settled by replaying
	 * them through a throwaway `ClaudeReducer` -- the same walk cold-start
	 * hydration does with the same records, so the answer is the reducer's by
	 * construction. Asking `claudePromptText` instead was the old way and it did
	 * not agree: it filters only `isSyntheticBlock`, while `handleUser` also drops
	 * `isSynthetic`, `isCompactSummary` and `isReplay` lines and routes
	 * `tool_result` blocks to a `toolResult` message. A compacted session
	 * therefore emitted a point with no user message behind it and pushed every
	 * ordinal after the compaction off by one; the replay fixes that as a side
	 * effect.
	 *
	 * The store lags the live transcript -- as of `claude 2.1.268` it gains no
	 * content until a turn ends (MANUAL_TESTING OW-japuzo), while `beginTurn`
	 * echoes the human's prompt into the reducer immediately -- so the replay is
	 * a *prefix* of the live array, and a prefix's indices are the live array's
	 * indices. Each point is checked against the live reducer before it ships:
	 * anything not landing on a user message there is dropped rather than
	 * shipped as an index into an array it does not describe.
	 */
	async listForkPoints(): Promise<ForkPoint[]> {
		this.requireProc();
		const entries = await this.readStore(this.currentRef.id);
		const replay = new ClaudeReducer();
		const live = this.reducer.getState().messages;
		const points: ForkPoint[] = [];
		let previousUuid: string | null = null;
		for (const entry of entries) {
			const before = replay.getState().messages.length;
			const event = asClaudeEvent(entry.record);
			if (event) replay.handle(event);
			if (entry.type === "user") {
				const produced = replay.getState().messages;
				for (let index = before; index < produced.length; index++) {
					const message = produced[index];
					if (message?.role !== "user") continue;
					if (live[index]?.role === "user") {
						points.push({
							id: previousUuid ?? CLAUDE_FORK_SESSION_START,
							text: userMessageText(message.content),
							index,
						});
					}
					break;
				}
			}
			previousUuid = entry.uuid;
		}
		return points;
	}

	/**
	 * Mint the forked session's id and the arguments that spawn it, and change
	 * nothing here: the parent keeps this adapter, this child and any turn still
	 * in flight (OW-razoki). The fork is spawned by its OWN adapter, which the
	 * manager starts with the returned `forkOf` -- the id is ours to choose
	 * (`--session-id`), so it is known before anything is written, which matters
	 * because the fork's store file does not exist until its first turn ends
	 * (OW-japuzo) and the session index therefore cannot find it.
	 *
	 * The cut is validated here rather than left to that start: this is what the
	 * `POST .../fork` route answers, and a fork point the parent's store does not
	 * carry must fail the request, not a later attach.
	 */
	async fork(entryId: string): Promise<ForkResult> {
		const cwd = this.cwd;
		if (!this.ownership || !cwd) throw new Error("claude adapter not started");
		const parentId = this.currentRef.id;
		const atStart = entryId === CLAUDE_FORK_SESSION_START;
		if (!atStart) await this.readForkHistory(parentId, entryId);
		// Only a fork that keeps no turn takes the parent's effort; one at an entry
		// reads its kept prefix's (module doc).
		const effort = atStart && this.effort ? { effort: this.effort } : {};
		return {
			ref: { backend: "claude", id: this.mintSessionId() },
			start: {
				cwd,
				forkOf: { parentId, entryId, ...effort },
				...(this.model ? { model: this.model } : {}),
			},
		};
	}

	// -- state --------------------------------------------------------------

	getState(): AdapterState {
		return { ...this.reducer.getState(), model: this.model, effort: this.effort };
	}

	onUpdate(cb: (state: AdapterState, changedIndex?: number) => void): Unsubscribe {
		this.updateListeners.add(cb);
		return () => this.updateListeners.delete(cb);
	}

	onRequest(cb: (request: AgentRequest) => void): Unsubscribe {
		this.requestListeners.add(cb);
		return () => this.requestListeners.delete(cb);
	}

	onError(cb: (message: string) => void): Unsubscribe {
		this.errorListeners.add(cb);
		return () => this.errorListeners.delete(cb);
	}

	/** Inert: nothing fires `onRequest` under sbox's bypassPermissions (see module doc). */
	async reply(_requestId: string, _response: unknown): Promise<void> {}

	// -- session controls ---------------------------------------------------

	async setModel(model: string): Promise<void> {
		await this.sendControl({ subtype: "set_model", model });
		// Only on success (a bogus id rejects above): remembered so `fork()` can
		// hand it to the fork's own adapter.
		this.model = model;
		this.modelFromStore = false;
		// A chosen effort outlives the switch, applied only while the model has
		// effort at all (module doc), so what is in force is read, not kept.
		await this.readSettings();
		this.emitUpdate();
	}

	/** Sent now over the control channel; the effort in force is then read back (module doc). */
	async setEffort(effort: string): Promise<void> {
		await this.sendControl({ subtype: "apply_flag_settings", settings: { effortLevel: effort } });
		await this.readSettings();
		this.emitUpdate();
	}

	/**
	 * The `initialize` control response carries the model list (the `init`
	 * event does not). It also carries the operator's account email -- never
	 * record this response in a fixture (OW-yilabe).
	 *
	 * Each entry's `supportedEffortLevels` are its efforts. No entry names a
	 * default, so `defaultEffort` is null; the CLI's pick for the current model
	 * is what `get_settings` reports and `getState().effort` carries.
	 */
	async listModels(): Promise<ModelInfo[]> {
		const response = await this.sendControl({ subtype: "initialize" });
		const models = isRecord(response) && Array.isArray(response.models) ? response.models : [];
		const out: ModelInfo[] = [];
		for (const model of models as ClaudeModelDescriptor[]) {
			if (typeof model?.value !== "string") continue;
			const levels = Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels : [];
			out.push({
				id: model.value,
				label: model.displayName || model.value,
				efforts: levels
					.filter((level): level is string => typeof level === "string")
					.map((id) => ({ id, description: "" })),
				defaultEffort: null,
			});
		}
		return out;
	}

	// -- internals ----------------------------------------------------------

	/**
	 * Adopt the effort the CLI will send on its next request, and, while no
	 * model is known or the known one is only the store's id, name the listed
	 * one in force (module doc).
	 */
	private async readSettings(): Promise<void> {
		const response = await this.sendControl({ subtype: "get_settings" });
		const applied = isRecord(response) && isRecord(response.applied) ? response.applied : null;
		if (!applied) return;
		this.effort = typeof applied.effort === "string" ? applied.effort : null;
		const inForce = applied.model;
		if (typeof inForce !== "string") return;
		if (this.modelFromStore) {
			const listed = listedModelFor(inForce, await this.sendControl({ subtype: "initialize" }), false);
			// A `setModel` that landed meanwhile chose a model, which outranks this.
			if (!this.modelFromStore) return;
			this.modelFromStore = false;
			this.model = listed ?? inForce;
			this.emitUpdate();
			return;
		}
		if (this.model !== null) return;
		const listed = listedModelFor(inForce, await this.sendControl({ subtype: "initialize" }), true);
		if (listed === null || this.model !== null) return;
		this.model = listed;
		this.emitUpdate();
	}

	private mintSessionId(): string {
		return this.options.newSessionId?.() ?? randomUUID();
	}

	private readStore(sessionId: string): Promise<ClaudeStoreMessageEntry[]> {
		if (this.options.readStoreEntries) return this.options.readStoreEntries(sessionId);
		return defaultReadStoreEntries(this.options.claudeRoot ?? DEFAULT_CLAUDE_ROOT, sessionId);
	}

	/**
	 * The slice of `parentId`'s store a fork at `entryId` keeps: truncation is
	 * INCLUSIVE of the named entry (OW-mayuza), so the named line survives.
	 */
	private async readForkHistory(
		parentId: string,
		entryId: string,
	): Promise<ClaudeStoreMessageEntry[]> {
		const entries = await this.readStore(parentId);
		const cut = entries.findIndex((entry) => entry.uuid === entryId);
		if (cut < 0) throw new Error(`unknown fork point: ${entryId}`);
		return entries.slice(0, cut + 1);
	}

	/** Adopt the model the last hydrated assistant message names, if nothing else has. */
	private adoptStoredModel(): void {
		if (this.model !== null) return;
		const last = this.lastHydratedAssistant();
		if (!last) return;
		this.model = last.model;
		this.modelFromStore = true;
		this.emitUpdate();
	}

	/** The model known so far, as a spawn option for a session whose store restores none. */
	private chosenModel(): { model?: string } {
		return this.model ? { model: this.model } : {};
	}

	/**
	 * The effort the last hydrated assistant message ran at, as the resume or
	 * fork's spawn option: a `--resume` does not restore it (module doc, D23).
	 */
	private storedEffort(): { effort?: string } {
		const effort = this.lastHydratedAssistant()?.effort;
		return effort ? { effort } : {};
	}

	/**
	 * The last assistant message a model ran. The CLI writes notices of its own
	 * as assistant store lines -- as of `claude 2.1.270`, a session-limit notice
	 * with `isApiErrorMessage: true`, `message.model: "<synthetic>"` and no
	 * `effort` -- and hydration keeps only the model, so that is the marker.
	 */
	private lastHydratedAssistant(): AssistantTurn | undefined {
		return this.reducer
			.getState()
			.messages.findLast(
				(message): message is AssistantTurn =>
					message.role === "assistant" && message.model !== SYNTHETIC_MODEL,
			);
	}

	private attachProcess(spawnOpts: {
		cwd: string;
		resumeId?: string;
		sessionId?: string;
		forkAtEntryId?: string;
		model?: string;
		effort?: string;
	}): Promise<void> {
		const spawner = this.options.spawn ?? spawnClaude;
		const proc = spawner({
			...spawnOpts,
			...(this.options.env ? { env: this.options.env } : {}),
		});
		const ownership: Ownership = { proc, live: true };
		this.ownership = ownership;
		let spawned = false;
		let resolveSpawn!: () => void;
		let rejectSpawn!: (error: Error) => void;
		const spawnResult = new Promise<void>((resolve, reject) => {
			resolveSpawn = resolve;
			rejectSpawn = reject;
		});
		proc.onSpawn(() => {
			spawned = true;
			resolveSpawn();
		});
		proc.onLine((line) => {
			if (!ownership.live) return;
			this.handleLine(line);
		});
		proc.onExit((code, signal, error) => {
			const exitError =
				error ?? new Error(`claude exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
			if (!spawned) rejectSpawn(exitError);
			if (!ownership.live) return;
			this.turnActive = false;
			this.rejectPendingControls(exitError);
			this.emitError(
				error?.message ?? `claude exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			);
		});
		return spawnResult;
	}

	private handleLine(line: string): void {
		const event = parseClaudeEventLine(line);
		if (!event) return;
		if (event.type === "control_response") {
			this.handleControlResponse(event);
			return;
		}
		if (event.type === "system" && event.subtype === "init") {
			const sessionId = (event as { session_id?: unknown }).session_id;
			// `--session-id`/`--resume` make this a confirmation, but the CLI is
			// authoritative about its own store.
			if (typeof sessionId === "string" && sessionId && sessionId !== this.currentRef.id) {
				this.currentRef = { backend: "claude", id: sessionId };
			}
			const model = (event as { model?: unknown }).model;
			if (typeof model === "string" && model && model !== this.model) {
				this.model = model;
				this.emitUpdate();
			}
		}
		if (event.type === "result") this.turnActive = false;
		this.applyEffects(this.reducer.handle(event));
	}

	private handleControlResponse(event: Extract<ClaudeEvent, { type: "control_response" }>): void {
		const response = event.response;
		const requestId = typeof response?.request_id === "string" ? response.request_id : null;
		if (!requestId) return;
		const pending = this.pendingControls.get(requestId);
		if (!pending) return;
		this.pendingControls.delete(requestId);
		if (response?.subtype === "error") {
			pending.reject(new Error(response.error ?? "claude control request failed"));
		} else {
			pending.resolve(response?.response);
		}
	}

	private sendControl(request: { subtype: string } & Record<string, unknown>): Promise<unknown> {
		const proc = this.requireProc();
		const requestId = `agentpane:${this.controlNamespace}:${this.controlSeq++}`;
		return new Promise((resolve, reject) => {
			this.pendingControls.set(requestId, { resolve, reject });
			try {
				proc.write(JSON.stringify(buildControlRequestLine(requestId, request)));
			} catch (error) {
				this.pendingControls.delete(requestId);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private rejectPendingControls(error: Error): void {
		const pending = [...this.pendingControls.values()];
		this.pendingControls.clear();
		for (const control of pending) control.reject(error);
	}

	private applyEffects(effects: ClaudeEffect[]): void {
		for (const effect of effects) {
			switch (effect.type) {
				case "message":
					this.emitUpdate(effect.index);
					break;
				case "reset":
				case "streaming":
				case "compaction":
					this.emitUpdate(undefined);
					break;
				case "error":
					this.emitError(effect.message);
					break;
			}
		}
	}

	private emitUpdate(changedIndex?: number): void {
		const state = this.getState();
		for (const listener of [...this.updateListeners]) listener(state, changedIndex);
	}

	private emitError(message: string): void {
		for (const listener of [...this.errorListeners]) listener(message);
	}

	private requireProc(): ClaudeProcess {
		if (!this.ownership?.live) throw new Error("claude adapter not started");
		return this.ownership.proc;
	}
}

async function defaultReadStoreEntries(
	root: string,
	sessionId: string,
): Promise<ClaudeStoreMessageEntry[]> {
	const file = await findClaudeSessionFile(root, sessionId);
	if (!file) return [];
	return readClaudeMessageEntries(file);
}

/**
 * The listed id, among `initialize`'s model entries, whose `resolvedModel` is
 * `resolved`, or null when none is. Several can share one: as of `claude
 * 2.1.280`, `default` and `opus[1m]` both resolved to `claude-opus-5-5[1m]`.
 * Then `default` wins when it is among them and `preferDefault` is set, as it
 * is for a session nobody chose a model on, and otherwise the first other id
 * in list order. A model a store restored never takes `default`, which names
 * the account's recommended model and so need not stay the conversation's.
 */
function listedModelFor(resolved: string, response: unknown, preferDefault: boolean): string | null {
	const models = isRecord(response) && Array.isArray(response.models) ? response.models : [];
	const matches = (models as ClaudeModelDescriptor[])
		.filter((model) => model?.resolvedModel === resolved && typeof model.value === "string")
		.map((model) => model.value as string);
	if (preferDefault && matches.includes("default")) return "default";
	return matches.find((value) => value !== "default") ?? null;
}

/** The fork point's label: the text of the user message the reducer built. */
function userMessageText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export class ClaudeAdapterFactory implements AdapterFactory {
	constructor(private readonly options: ClaudeAdapterOptions = {}) {}

	create(ref: SessionRef): BackendAdapter {
		if (ref.backend !== "claude") {
			throw new Error(`ClaudeAdapterFactory cannot create a "${ref.backend}" adapter`);
		}
		return new ClaudeAdapter(ref, this.options);
	}
}
