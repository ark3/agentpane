/**
 * `BackendAdapter` for Claude Code, driving `claude -p` over stream-json in
 * both directions (OW-beripo). This is the shell: spawn, control-channel
 * correlation, and the command surface; the event->message translation is
 * `reducer.ts`/`mapping.ts`'s.
 *
 * Where it differs from the Codex shell, by protocol:
 *
 * - A turn is a user-message line on stdin, which no reply answers, and only
 *   `result` ends it. A line written mid-turn would run as a later turn and
 *   there is no `steer` subtype, so `submit()` and `compact()` refuse while a
 *   turn runs (docs/BACKENDS.md, "A message written mid-turn").
 * - The session id is ours, chosen at spawn (`ClaudeSpawnOptions.sessionId`),
 *   so a fresh session and a fork know theirs at once, and nothing waits on
 *   `init`, which arrives only with the first turn (settled live 2026-08-25).
 * - `fork()` runs nothing: the fork's own adapter spawns `--resume <parentId>
 *   --resume-session-at <entryId> --fork-session --session-id <forkId>`, and
 *   the parent keeps its child and its turn (`fork`). Respawning this child
 *   onto the fork would kill a parent turn still streaming and lose it, its
 *   store gaining nothing until the turn ends; as of `claude 2.1.268` the CLI
 *   ran two live children on one workspace (docs/BACKENDS.md, "A fork
 *   spawned mid-stream"). The parent's store file is untouched and no lineage
 *   marker exists on disk (OW-mayuza).
 * - No agent request is expected (D2a): sbox's claude profile injects
 *   `bypassPermissions` (`buildClaudeSpawnCommand`), and `can_use_tool` is
 *   sent only under the undocumented `--permission-prompt-tool stdio`, which
 *   this adapter does not pass (fixture `permission-request.jsonl`). One that
 *   arrives anyway is refused (`refuseControlRequest`).
 *
 * The effort in force is read back from `get_settings`'s `applied.effort` at
 * start, after `setEffort`'s `apply_flag_settings` and after `setModel`,
 * never assumed from a request. As of `claude 2.1.280` (home server,
 * 2026-09-23; docs/MANUAL_TESTING.md, OW-hokaye): `low` applied at once; a
 * model without effort (haiku) read null with the choice still held, which
 * came back on a `set_model` to one with effort; an unknown level was
 * accepted and ignored; and the choice died with the process.
 *
 * A `--resume` does not restore the stored effort: on the same version a
 * sonnet session whose turn ran at `low`, and a copy of one whose every turn
 * ran at `max`, each resumed at `high`, as did a `--fork-session` spawn of
 * the latter (OW-hokaye, OW-nabano). So a resume or a fork is spawned with
 * `--effort` at the level its last hydrated assistant message records
 * (`storedEffort`, D23), and a fork before the first message, which keeps
 * none, at the parent's in force, none where that read null (OW-sababi).
 * The flag, because it holds from the process's first instant: on `claude
 * 2.1.280` (OW-nabano) `--effort low` and `--effort max` on a `--resume`,
 * and `low` on a `--fork-session` spawn, read back as given, `max` though it
 * is session-scoped; `--effort bogus` was ignored rather than failing the
 * spawn; and a later `apply_flag_settings` still overrode the flag.
 *
 * The CLI restores the stored model itself, so a resume and a fork at an
 * entry are spawned with no `--model`, save one given at start to a resume,
 * or the parent's for a fork whose kept prefix names none. On `claude
 * 2.1.280` (OW-tebibo), with the settings naming `opus[1m]`, a `--resume`
 * with no `--model` put in force the `message.model` of the last assistant
 * line that is not `<synthetic>`, a `--fork-session` spawn its kept
 * prefix's, and a stored `claude-opus-5-5` came back as
 * `claude-opus-5-5[1m]`, a variant that passing the stored id would drop.
 *
 * So the stored id is only what `getState().model` names first: the start
 * read of `get_settings` renames it by `applied.model`, the model in force,
 * mapped back to the listed id that resolves to it (`listedModelFor`), or
 * kept as the resolved id where none does. That is the name `fork()` hands a
 * fork before the first message as `--model`, so it runs what the parent
 * runs, `[1m]` included: on `claude 2.1.280` `--model opus[1m]` and `--model
 * claude-opus-5-5[1m]` put `claude-opus-5-5[1m]` in force where a bare
 * `claude-opus-5-5` did not, and a resolved id no listed id maps to, passed
 * as `--model`, put itself back (OW-faledu). After a turn, `init`'s model
 * replaces the name: it carries the `[1m]` variant, as `applied.model` does,
 * where the assistant event and store line leave it off (same version,
 * OW-lizupu).
 *
 * A session nobody chose a model on is named one at start too, since the
 * clients offer efforts by the session's model (OW-kakide), and `default`
 * only where it resolves to the model in force: on `claude 2.1.280`
 * `default` resolved to the account's recommended model whatever the
 * settings named, and `--model default` or a `set_model` to it put that same
 * model in force, which is what makes the name safe to hand a fork. The start
 * read never overwrites a model chosen at start or since; a turn's `init`
 * does.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
	AssistantTurn,
	ForkPoint,
	ModelInfo,
	PromptDisposition,
	SessionRef,
} from "../../../shared/protocol.ts";
import {
	findClaudeSessionFile,
	readClaudeMessageEntries,
	type ClaudeStoreMessageEntry,
} from "../../sessions/claude.ts";
import {
	type AdapterState,
	type AdapterFactory,
	type BackendAdapter,
	BackendRefusedError,
	type ForkResult,
	type ImageInput,
	type StartOptions,
	type StateChange,
	type Unsubscribe,
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

/** A control request the CLI answered with `subtype: "error"`: it is alive and said no, unlike an exit or a failed write. */
class ClaudeControlError extends Error {}

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
	/**
	 * The title the last `system` `session_title_changed` named, a rename
	 * `setName` sent included (D34 point 5). As of `claude 2.1.328` the CLI
	 * also sent one unprompted at a resume or a fork of a titled session,
	 * naming the stored title (resources/fixtures/claude/rename.meta.json).
	 * Null until one arrives.
	 */
	private name: string | null = null;
	private started = false;
	private turnActive = false;
	private disposed = false;
	private disposal: Promise<void> | null = null;

	private controlSeq = 0;
	private readonly controlNamespace = randomUUID();
	private readonly pendingControls = new Map<string, PendingControl>();

	private updateListeners = new Set<(state: AdapterState, change: StateChange) => void>();
	private errorListeners = new Set<(message: string) => void>();
	private refListeners = new Set<(ref: SessionRef, cause: "rename" | "fork") => void>();
	private exitListeners = new Set<(report: string) => void>();

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
	 * `start()` resolved (`handleLine`). Each move is announced through
	 * `onRefChanged` as a rename, and a resume of the id already held announces
	 * nothing. `fork()` does NOT move it: the fork is a second session with an
	 * adapter of its own (OW-razoki).
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
					this.emitUpdate("status");
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
			this.moveTo(opts.resumeId);
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
			this.moveTo(sessionId);
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
		this.errorListeners.clear();
		this.refListeners.clear();
		this.rejectPendingControls(new Error("claude adapter disposed"));
		await ownership?.proc.kill();
	}

	// -- driving a turn -----------------------------------------------------

	async submit(text: string, images?: ImageInput[]): Promise<PromptDisposition> {
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
		return "started";
	}

	/** Resolves empty: a mid-turn prompt is refused here (D16), so nothing is ever queued to hand back. */
	async abort(): Promise<string[]> {
		if (!this.turnActive) return [];
		try {
			await this.sendControl({ subtype: "interrupt" });
		} catch {
			// "Not currently executing" and its kin: the goal state -- no running
			// turn -- already holds, so an errored interrupt is not a failure.
		}
		return [];
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

	/** A fork leaves the parent's child and its turn running (OW-razoki); D15 stops nothing here. */
	readonly forkStopsTurn = false;

	/**
	 * One fork point per human prompt, labelled with that prompt's text and
	 * carrying that prompt's index in the flat transcript (OW-roveze).
	 * Truncation via `--resume-session-at` is INCLUSIVE of the named entry
	 * (OW-mayuza), so the point for "fork before prompt X" carries the uuid of
	 * the message entry PRECEDING X -- and the first prompt, which nothing
	 * precedes, carries `CLAUDE_FORK_SESSION_START`.
	 *
	 * Which store lines are prompts, and where they land, is settled by
	 * replaying them through a throwaway `ClaudeReducer`, the walk cold-start
	 * hydration does, so the answer is the reducer's by construction; a filter
	 * of its own would miss the lines `handleUser` drops or routes elsewhere,
	 * as a compaction summary's.
	 *
	 * The store lags the live transcript, as of `claude 2.1.268` gaining
	 * nothing until a turn ends (docs/BACKENDS.md, "A fork spawned
	 * mid-stream"), while `beginTurn` adds the prompt at once, so the replay is
	 * a prefix of the live array and its indices are the live array's. A point
	 * that does not land on a user message in the live reducer is dropped.
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
	 * because nothing has spawned to write the fork's store file when this
	 * returns, and the session index therefore cannot find it.
	 *
	 * The cut is validated here rather than left to that start: this is what a
	 * `sessions/forkAndPrompt` forks by, and a fork point the parent's store does not
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
		return { ...this.reducer.getState(), model: this.model, effort: this.effort, unrestoredModel: null, name: this.name };
	}

	onUpdate(cb: (state: AdapterState, change: StateChange) => void): Unsubscribe {
		this.updateListeners.add(cb);
		return () => this.updateListeners.delete(cb);
	}

	onError(cb: (message: string) => void): Unsubscribe {
		this.errorListeners.add(cb);
		return () => this.errorListeners.delete(cb);
	}

	onRefChanged(cb: (ref: SessionRef, cause: "rename" | "fork") => void): Unsubscribe {
		this.refListeners.add(cb);
		return () => this.refListeners.delete(cb);
	}

	onExit(cb: (report: string) => void): Unsubscribe {
		this.exitListeners.add(cb);
		return () => this.exitListeners.delete(cb);
	}

	// -- session controls ---------------------------------------------------

	async setModel(model: string): Promise<void> {
		await this.sendControl({ subtype: "set_model", model }).catch((error: unknown) => {
			throw error instanceof ClaudeControlError ? new BackendRefusedError(error.message) : error;
		});
		// Only on success (a bogus id rejects above): remembered so `fork()` can
		// hand it to the fork's own adapter.
		this.model = model;
		this.modelFromStore = false;
		// A chosen effort outlives the switch, applied only while the model has
		// effort at all (module doc), so what is in force is read, not kept.
		await this.readSettings();
		this.emitUpdate("status");
	}

	/**
	 * The `rename_session` control request, which as of `claude 2.1.270` the
	 * CLI answered with success mid-session (docs/MANUAL_TESTING.md, "All three
	 * backends rename an attached session over the wire"). Not `/rename` as a
	 * user message: that works too, but runs as a turn.
	 *
	 * The name is taken from the `system` `session_title_changed` it also
	 * sends, not from its reply, which only ends the request (D34 point 5).
	 * On `claude 2.1.328` the event came just ahead of the reply, before a
	 * turn and after one (resources/fixtures/claude/rename.jsonl), so the
	 * session's update goes out before the command's reply as D31 orders
	 * them. That order is relied on, not waited for: a CLI that reversed it
	 * would put the reply ahead of the update (docs/BACKENDS.md).
	 */
	async setName(name: string): Promise<void> {
		await this.sendControl({ subtype: "rename_session", title: name });
	}

	/** Sent now over the control channel; the effort in force is then read back (module doc). */
	async setEffort(effort: string): Promise<void> {
		await this.sendControl({ subtype: "apply_flag_settings", settings: { effortLevel: effort } });
		await this.readSettings();
		this.emitUpdate("status");
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
			this.emitUpdate("status");
			return;
		}
		if (this.model !== null) return;
		const listed = listedModelFor(inForce, await this.sendControl({ subtype: "initialize" }), true);
		if (listed === null || this.model !== null) return;
		this.model = listed;
		this.emitUpdate("status");
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
		if (cut < 0) throw new BackendRefusedError(`unknown fork point: ${entryId}`);
		return entries.slice(0, cut + 1);
	}

	/** Adopt the model the last hydrated assistant message names, if nothing else has. */
	private adoptStoredModel(): void {
		if (this.model !== null) return;
		const last = this.lastHydratedAssistant();
		if (!last) return;
		this.model = last.model;
		this.modelFromStore = true;
		this.emitUpdate("status");
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
		proc.onLine(
			(line) => {
				if (!ownership.live) return;
				this.handleLine(line);
			},
			(message) => {
				if (ownership.live) this.emitError(message);
			},
		);
		proc.onExit((code, signal, error) => {
			const exitError =
				error ?? new Error(`claude exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
			if (!spawned) rejectSpawn(exitError);
			if (!ownership.live) return;
			this.turnActive = false;
			this.rejectPendingControls(exitError);
			this.emitExit(exitError.message);
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
		if (event.type === "control_request") {
			this.refuseControlRequest(event);
			return;
		}
		if (event.type === "system" && event.subtype === "init") {
			const sessionId = (event as { session_id?: unknown }).session_id;
			// `--session-id`/`--resume` make this a confirmation, but the CLI is
			// authoritative about its own store. Announced before this line's
			// update and the reducer's effects, which belong to the new id.
			if (typeof sessionId === "string" && sessionId) this.moveTo(sessionId);
			const model = (event as { model?: unknown }).model;
			if (typeof model === "string" && model && model !== this.model) {
				this.model = model;
				this.emitUpdate("status");
			}
		}
		if (event.type === "system" && event.subtype === "session_title_changed") {
			const title = (event as { title?: unknown }).title;
			if (typeof title === "string") {
				this.name = title;
				this.emitUpdate("status");
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
			pending.reject(new ClaudeControlError(response.error ?? "claude control request failed"));
		} else {
			pending.resolve(response?.response);
		}
	}

	/**
	 * agentpane never holds an agent request (D2a): one the CLI sends is
	 * refused here, in the tick it arrives, and named in a session error.
	 * None should arrive under the flags this adapter spawns with (module doc),
	 * so reaching this line means a premise broke. `can_use_tool` gets the
	 * deny a model reads as a "no"; any other subtype gets the generic error
	 * reply, the shape the CLI itself uses. Measured live on the home server,
	 * 2026-09-29, `claude 2.1.283` (docs/MANUAL_TESTING.md, OW-kihubu), each
	 * answering a `can_use_tool` became an `is_error` tool result the model
	 * read, and the turn went on to its `result`. `can_use_tool` is the only
	 * subtype the CLI could be made to send, so the error reply is measured on
	 * it alone. `reply` drops the answer once the child is gone, so a request
	 * line still draining after it died cannot throw out of the line handler
	 * (`ChildProcessShell.reply`, OW-yofoli).
	 */
	private refuseControlRequest(event: Extract<ClaudeEvent, { type: "control_request" }>): void {
		const subtype = event.request?.subtype ?? "unknown";
		const proc = this.requireProc();
		if (subtype === "can_use_tool") {
			const deny = {
				behavior: "deny",
				message: "agentpane cannot answer can_use_tool; it declined this tool use",
			};
			proc.reply(
				JSON.stringify({
					type: "control_response",
					response: { subtype: "success", request_id: event.request_id, response: deny },
				}),
			);
			this.emitError(
				"claude sent a request agentpane cannot answer (can_use_tool); agentpane declined it",
			);
			return;
		}
		proc.reply(
			JSON.stringify({
				type: "control_response",
				response: {
					subtype: "error",
					request_id: event.request_id,
					error: `agentpane cannot answer ${subtype}`,
				},
			}),
		);
		this.emitError(`claude sent an unsupported request (${subtype}); agentpane declined it`);
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
					this.emitUpdate("transcript");
					break;
				case "streaming":
				case "compaction":
					this.emitUpdate("status");
					break;
				case "error":
					this.emitError(effect.message);
					break;
			}
		}
	}

	private emitUpdate(change: StateChange): void {
		const state = this.getState();
		for (const listener of [...this.updateListeners]) listener(state, change);
	}

	private emitError(message: string): void {
		for (const listener of [...this.errorListeners]) listener(message);
	}

	private emitExit(report: string): void {
		for (const listener of [...this.exitListeners]) listener(report);
	}

	/** Take `sessionId` as the id, announcing it when it is a different one. */
	private moveTo(sessionId: string): void {
		if (sessionId === this.currentRef.id) return;
		this.currentRef = { backend: "claude", id: sessionId };
		for (const listener of [...this.refListeners]) listener(this.currentRef, "rename");
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
