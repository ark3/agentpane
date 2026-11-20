/**
 * Shared machinery for the probes that drive agentpane's own API.
 *
 * Each such probe launches the production server, talks to it over the one
 * socket (D31), walks the process tree it owns, and proves the run cleaned up
 * after itself; only which backend it drives and what it asserts differ.
 * Ported from `agentpane_live_support.py` when the HTTP command routes and the
 * event stream were retired (ark3/agentpane#54).
 *
 * Two guarantees this module is responsible for, because every probe using it
 * claims them:
 *
 * - **Credentials are copied by name and never printed.** Callers pass the file
 *   names their backend needs; nothing here reads their contents.
 * - **Process inspection is scoped to the launched server's tree.** Finding
 *   descendants costs one parent link per process, which is the only way Linux
 *   answers the question. Command lines are read only for pids already
 *   established as descendants, so nothing outside the tree is ever opened.
 */

import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { apiTokenPath } from "../../src/server/api-token.ts";
import { type CommandName, type Commands, ROUTES } from "../../src/shared/protocol.ts";

/** The checkout this file sits in. */
export const REPO = resolve(import.meta.dir, "../..");

export const HOST = "127.0.0.1";

/** Local time with its offset and milliseconds, as the Python probes stamped it. */
export function now(): string {
	const date = new Date();
	const offset = -date.getTimezoneOffset();
	const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, -1);
	const sign = offset >= 0 ? "+" : "-";
	const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
	const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
	return `${local}${sign}${hours}:${minutes}`;
}

export function sleep(seconds: number): Promise<void> {
	return Bun.sleep(seconds * 1000);
}

/** A CLI's `--version`, trimmed. */
export function cliVersion(command: string): string {
	return Bun.spawnSync([command, "--version"]).stdout.toString().trim();
}

// ---------------------------------------------------------------------------
// the socket
// ---------------------------------------------------------------------------

/**
 * The server's API token, or undefined while its file does not exist.
 *
 * Read from the file at each connect, never from the environment: every agent
 * is a child of the server and inherits its environment, and the server
 * creates the file on its first start, so a probe that read it before its own
 * server was listening would find nothing. Trailing whitespace is trimmed, as
 * the server trims it.
 */
export function readApiToken(): string | undefined {
	try {
		return readFileSync(apiTokenPath(), "utf8").trimEnd() || undefined;
	} catch {
		return undefined;
	}
}

/** Events are read loosely: a probe looks at fields a fixture's text decides. */
export type WireEvent = Record<string, any>;

/** Each event as it arrived, stamped with `now()`. */
export type Stamped = [string, WireEvent];

export type Reply<K extends CommandName = CommandName> =
	| { ok: true; result: Commands[K]["result"] }
	| { ok: false; code: string; detail: string; fork?: unknown; attached?: unknown };

/**
 * One socket to the server, recording every event it is sent and settling
 * each command's reply by its `id`.
 *
 * Frames are handled in arrival order and an event is recorded before any
 * reply after it settles, so a reply's continuation sees every event the
 * server wrote before it (D31 point 3).
 */
export class AgentpaneSocket {
	readonly events: Stamped[] = [];
	/** Set once the socket has closed, from either end. */
	closed: { code: number; reason: string } | undefined;
	/** Settles with the close, whoever closed it. */
	readonly closing: Promise<{ code: number; reason: string }>;

	private readonly socket: WebSocket;
	private readonly pending = new Map<string, (reply: Reply) => void>();
	private lastId = 0;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		this.closing = new Promise((settle) => {
			socket.addEventListener("close", (event) => {
				this.closed = { code: event.code, reason: event.reason };
				for (const [, settleReply] of this.pending) {
					settleReply({ ok: false, code: "connection_lost", detail: `socket closed ${event.code} ${event.reason}` });
				}
				this.pending.clear();
				settle(this.closed);
			});
		});
		socket.addEventListener("message", (message) => {
			const frame = JSON.parse(String(message.data));
			if (frame.type === "event") {
				this.events.push([now(), frame.event]);
			} else if (frame.type === "reply") {
				const settleReply = this.pending.get(frame.id);
				this.pending.delete(frame.id);
				const { type: _type, id: _id, ...reply } = frame;
				settleReply?.(reply);
			}
		});
	}

	/**
	 * A socket opened but sent nothing: for a probe whose point is what the
	 * server does with a first frame that is not a valid `hello`.
	 */
	static async connect(port: number, host = HOST, timeoutSeconds = 10): Promise<AgentpaneSocket> {
		const socket = new WebSocket(`ws://${host}:${port}${ROUTES.socket}`);
		const opened = new Promise<void>((done, fail) => {
			socket.addEventListener("open", () => done(), { once: true });
			socket.addEventListener("error", () => fail(new Error("the socket did not open")), { once: true });
		});
		const client = new AgentpaneSocket(socket);
		await withTimeout(opened, timeoutSeconds, "the socket to open");
		return client;
	}

	/**
	 * A socket whose `hello` was answered: the opening snapshots are already
	 * in `events`. Throws when the server refused the hello.
	 */
	static async open(port: number, host = HOST): Promise<AgentpaneSocket> {
		const client = await AgentpaneSocket.connect(port, host);
		const reply = await client.request("hello", { token: readApiToken() ?? "" }, 10);
		if (!reply.ok) throw new Error(`hello refused: ${reply.code} ${reply.detail}`);
		return client;
	}

	/** One raw frame, as given. */
	send(frame: unknown): void {
		this.socket.send(JSON.stringify(frame));
	}

	/**
	 * One command and its reply. A socket that closes first answers
	 * `connection_lost`, its outcome unknown (D31 point 6).
	 */
	request<K extends CommandName>(cmd: K, params: Commands[K]["params"], timeoutSeconds = 60): Promise<Reply<K>> {
		if (this.closed) {
			return Promise.resolve({ ok: false, code: "connection_lost", detail: "the socket is closed" });
		}
		const id = String(++this.lastId);
		const reply = new Promise<Reply<K>>((settle) => this.pending.set(id, settle as (reply: Reply) => void));
		this.send({ ...params, id, cmd });
		return withTimeout(reply, timeoutSeconds, `the reply to ${cmd}`);
	}

	/** A request that must be admitted; its result, or an error naming the refusal. */
	async ok<K extends CommandName>(cmd: K, params: Commands[K]["params"], timeoutSeconds = 60): Promise<Commands[K]["result"]> {
		const reply = await this.request(cmd, params, timeoutSeconds);
		if (!reply.ok) throw new Error(`${cmd} refused: ${reply.code} ${reply.detail}`);
		return reply.result;
	}

	snapshot(): Stamped[] {
		return [...this.events];
	}

	/** Polls `predicate` over the events so far until it answers something truthy. */
	async waitFor<T>(predicate: (events: Stamped[]) => T | null | undefined | false, timeoutSeconds: number, label: string): Promise<T> {
		const deadline = performance.now() + timeoutSeconds * 1000;
		while (performance.now() < deadline) {
			const value = predicate(this.snapshot());
			if (value) return value;
			if (this.closed) throw new Error(`the socket closed (${this.closed.code}) while waiting for ${label}`);
			await Bun.sleep(50);
		}
		throw new TimeoutError(`timed out waiting for ${label}; saw ${this.events.length} events`);
	}

	async close(): Promise<void> {
		if (!this.closed) this.socket.close();
		await withTimeout(this.closing, 2, "the socket to close").catch(() => undefined);
	}
}

export class TimeoutError extends Error {
	override name = "TimeoutError";
}

export function withTimeout<T>(promise: Promise<T>, seconds: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, fail) => {
		timer = setTimeout(() => fail(new TimeoutError(`timed out waiting for ${label}`)), seconds * 1000);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// process tree
// ---------------------------------------------------------------------------

export interface ProcessRow {
	pid: number;
	ppid: number;
	comm: string;
	cmd: string;
}

/**
 * This process's parent, and nothing else about it.
 *
 * `/proc/<pid>/stat` is `pid (comm) state ppid ...`, and `comm` may contain
 * both spaces and parentheses. Splitting the whole line on whitespace and
 * taking field 3 therefore misreads the parent of any process whose name has
 * a space in it -- which either hides a real descendant of this run or
 * attributes an unrelated process to it. Parse after the final `)`.
 */
export function ppidOf(pid: number): number | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const parent = Number(raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/)[1]);
		return Number.isInteger(parent) ? parent : undefined;
	} catch {
		return undefined;
	}
}

export function isAlive(pid: number): boolean {
	return existsSync(`/proc/${pid}`);
}

/** Live descendants of `root`, with command lines read for those alone. */
export function descendants(root: number): ProcessRow[] {
	const links = new Map<number, number>();
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		const parent = ppidOf(Number(name));
		if (parent !== undefined) links.set(Number(name), parent);
	}
	const children = new Map<number, number[]>();
	for (const [pid, parent] of links) children.set(parent, [...(children.get(parent) ?? []), pid]);

	const found: number[] = [];
	const seen = new Set([root]);
	const frontier = [root];
	while (frontier.length) {
		for (const child of children.get(frontier.pop()!) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			found.push(child);
			frontier.push(child);
		}
	}

	const rows: ProcessRow[] = [];
	for (const pid of found.sort((a, b) => a - b)) {
		try {
			const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
			const cmd = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ").trim();
			rows.push({ pid, ppid: links.get(pid)!, comm, cmd });
		} catch {
			// exited while we walked; it is not a survivor either way
		}
	}
	return rows;
}

/** Tree rows without full command lines, which is what belongs in evidence. */
export function compactTree(rows: ProcessRow[]): { pid: number; ppid: number; comm: string; argv0: string }[] {
	return rows.map((row) => ({ pid: row.pid, ppid: row.ppid, comm: row.comm, argv0: row.cmd.split(" ", 1)[0] ?? "" }));
}

/** The pids among `pids` still alive, sorted. */
export function alive(pids: Iterable<number>): number[] {
	return [...pids].filter(isAlive).sort((a, b) => a - b);
}

/**
 * Wait out this run's own agent workers, then kill whatever is left.
 *
 * Every pid here was recorded while it was a descendant of the server this
 * run launched. That is an identity at the time of observation, not a
 * guarantee at the time of signalling: after the wait below, a pid the
 * kernel has recycled would belong to something else. The window is small
 * and this is a developer probe, but the claim is "signals only pids that
 * were ours", not "cannot possibly signal anything else".
 *
 * A harness that quietly leaves a sandboxed agent running is worse than one
 * that reports the leak, so survivors are both killed and returned.
 */
export async function reap(pids: Set<number>, graceSeconds: number): Promise<number[]> {
	const deadline = performance.now() + graceSeconds * 1000;
	let left = alive(pids);
	while (left.length && performance.now() < deadline) {
		await Bun.sleep(100);
		left = alive(pids);
	}
	for (const pid of left) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone, or not ours to signal
		}
	}
	return left;
}

// ---------------------------------------------------------------------------
// reading the transcript off the wire
// ---------------------------------------------------------------------------

export type Message = Record<string, any>;

export function assistantText(message: Message | undefined): string {
	if (message?.role !== "assistant") return "";
	return (message.content ?? [])
		.filter((block: Message) => block && typeof block === "object" && block.type === "text")
		.map((block: Message) => block.text ?? "")
		.join("");
}

export function messageBlockTypes(message: Message | undefined): string[] {
	return (message?.content ?? [])
		.filter((block: Message) => block && typeof block === "object")
		.map((block: Message) => block.type ?? "");
}

/**
 * A session as a probe names it: the `handle` its create or attach reply
 * carried, which a rename never moves (D24), or a ref, which a rename does.
 */
export type Session = string | { backend: string; id: string };

function sameRef(a: unknown, b: unknown): boolean {
	return (
		typeof a === "object" && a !== null && typeof b === "object" && b !== null &&
		(a as Message).backend === (b as Message).backend && (a as Message).id === (b as Message).id
	);
}

/**
 * Whether `event` is under `session`, by handle or by ref.
 *
 * Since OW-mofuho retired the `renamed` event (2026-09-25), a rename is said
 * only by a `snapshot` under the session's handle carrying the new ref, so a
 * probe that keys its waits by a ref stops matching its own session's events
 * the moment it moves.
 */
export function isOf(event: WireEvent, session: Session): boolean {
	return typeof session === "string" ? event.handle === session : sameRef(event.session, session);
}

/**
 * Every ref the session under `handle` carried on the wire, oldest first.
 *
 * One entry per move (D9): what a probe records, rather than requires, about
 * a rename. The last entry is the session's current ref, though any of them
 * still reaches it, because the server honours every name it ever had.
 */
export function refsUnder(events: Stamped[], handle: string): { backend: string; id: string }[] {
	const refs: { backend: string; id: string }[] = [];
	for (const [, event] of events) {
		const ref = event.session;
		if (event.handle === handle && ref && typeof ref === "object" && !sameRef(refs.at(-1), ref)) refs.push(ref);
	}
	return refs;
}

export function streamingValue(event: WireEvent, session: Session): boolean | undefined {
	if (!isOf(event, session) || (event.type !== "snapshot" && event.type !== "status")) return undefined;
	return typeof event.isStreaming === "boolean" ? event.isStreaming : undefined;
}

/** The most recent streaming state this session was reported to be in. */
export function lastStreaming(events: Stamped[], session: Session): boolean | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const value = streamingValue(events[i]![1], session);
		if (value !== undefined) return value;
	}
	return undefined;
}

/** Longest assistant text seen for this session, across upserts and snapshots. */
export function maxAssistantLength(events: Stamped[], session: Session): number {
	let longest = 0;
	for (const [, event] of events) {
		if (!isOf(event, session)) continue;
		if (event.type === "upsert") longest = Math.max(longest, assistantText(event.message).length);
		else if (event.type === "snapshot") {
			for (const message of event.messages ?? []) longest = Math.max(longest, assistantText(message).length);
		}
	}
	return longest;
}

/**
 * This session's transcript as the wire has described it so far.
 *
 * Replayed the way a client holds it (`src/shared/protocol.ts`): a `snapshot`
 * replaces the whole array, an `upsert` writes `message` at `index`, which
 * may equal the length to append. Nothing else on the wire touches it. The
 * wire names a message by that position alone -- `PaneMessage` carries no
 * id -- so a position in this array is the only handle a probe has on one.
 */
export function transcript(events: Stamped[], session: Session): Message[] {
	let messages: Message[] = [];
	for (const [, event] of events) {
		if (!isOf(event, session)) continue;
		if (event.type === "snapshot") messages = [...(event.messages ?? [])];
		else if (event.type === "upsert") {
			const index = event.index;
			if (!Number.isInteger(index) || index < 0 || index > messages.length) {
				// A gap the wire contract does not allow; a reader that papered
				// over it would attribute text to the wrong position.
				throw new Error(`upsert at index ${index} against a transcript of ${messages.length}`);
			}
			messages[index] = event.message ?? {};
		}
	}
	return messages;
}

export interface TurnRow {
	index: number;
	role: unknown;
	chars: number;
}

/**
 * What one turn added to the transcript: every message past the cut.
 *
 * `start` is a cut taken immediately before the turn's prompt was sent, with
 * the session idle, so the transcript's length at that cut is where the turn
 * begins and every position past it is the turn's: its own user message, then
 * whatever the backend produced for it. Each row is the position, the role,
 * and the assistant text length (0 for anything that is not assistant text).
 *
 * A turn may produce more than one assistant message -- Pi opens one per
 * model call, and Codex maps each `ThreadItem` to its own -- and all of them
 * count. Picking one would undercount a turn split across several, while the
 * floor alone already excludes every earlier turn (OW-sofige).
 */
export function turnMessages(events: Stamped[], session: Session, start: number): TurnRow[] {
	const floor = transcript(events.slice(0, start), session).length;
	return transcript(events, session)
		.map((message, index) => ({ index, role: message.role, chars: assistantText(message).length }))
		.filter((row) => row.index >= floor);
}

/** Total assistant text across `turnMessages` rows. */
export function assistantChars(rows: TurnRow[]): number {
	return rows.reduce((total, row) => total + row.chars, 0);
}

/**
 * Evidence that a transcript arrived incrementally rather than in one lump.
 *
 * Returns as soon as growth is established, so `last` is a length mid-stream,
 * not the completed message.
 */
export function growingAssistantText(events: Stamped[], session: Session, start: number) {
	const lengthsByIndex = new Map<number, number[]>();
	for (const [, event] of events.slice(start)) {
		if (event.type !== "upsert" || !isOf(event, session)) continue;
		const text = assistantText(event.message);
		if (text) lengthsByIndex.set(event.index ?? -1, [...(lengthsByIndex.get(event.index ?? -1) ?? []), text.length]);
	}
	for (const [index, lengths] of lengthsByIndex) {
		const distinct = [...new Set(lengths)].sort((a, b) => a - b);
		if (distinct.length >= 2 && distinct.at(-1)! > distinct[0]!) {
			return { index, updates: lengths.length, distinct_lengths: distinct.length, first: distinct[0]!, last: distinct.at(-1)! };
		}
	}
	return undefined;
}

/**
 * The first idle report after a streaming one, both since `start`: a turn
 * that began and ended. Names the stamps of each and the idle event's type.
 */
export function idleAfterStreaming(events: Stamped[], session: Session, start: number) {
	let streamingAt: string | undefined;
	for (const [stamp, event] of events.slice(start)) {
		const value = streamingValue(event, session);
		if (value === true) streamingAt = stamp;
		if (streamingAt && value === false) return { streaming_at: streamingAt, idle_at: stamp, idle_event_type: event.type };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// the long turn the smoke probes abort
// ---------------------------------------------------------------------------

/**
 * The prompt whose turn the smoke probes abort. The phase exists to tear down
 * a large in-flight transcript, so the prompt has to be one the pinned models
 * write at length. Until OW-sofige both probes asked for "the integers from 1
 * through 10000, one per line", and neither model wrote them: as of `pi 0.85.1`
 * DeepSeek V4.1 Flash declined in all six runs measured on 2026-09-13 (session
 * maxima no higher than 472 characters), and as of `codex-cli 0.157.1` on
 * 2026-09-30 Luna's turn ended on its own after 76. This handbook was complied
 * with by both on 2026-09-30 (`pi 0.87.1`, `codex-cli 0.157.1`), each passing
 * 20000 characters still streaming; `docs/MANUAL_TESTING.md` (OW-sofige) has
 * the runs. Twenty chapters of 400 words is roughly twice what the wait below
 * needs, so a model that writes short chapters still has the turn running at
 * the cut.
 */
export const LONG_PROMPT =
	"Do not use tools. Write a long, detailed handbook on growing vegetables in a home garden. " +
	"Write twenty chapters, each under its own title and each at least 400 words long, covering in order: " +
	"planning the plot, soil testing, soil preparation, raised beds, choosing varieties, starting seeds indoors, " +
	"transplanting, direct sowing, watering, mulching, sunlight and siting, fertilising, composting, " +
	"companion planting, pest control, disease control, weeding, crop rotation, harvesting, and storing the harvest. " +
	"Write every chapter in full and do not summarise or abbreviate any of them.";

/**
 * How much of the long turn's own text to let build up before the abort, and
 * how long to wait for it. A wait, not a check: the abort goes out on timeout
 * with whatever the turn holds, and the length is reported, never asserted,
 * because how much a model writes is the model's.
 */
export const ABORT_AT_CHARS = 20000;
export const ABORT_WAIT_SECONDS = 150;

/**
 * Wait until the turn begun at `start` holds `ABORT_AT_CHARS` of assistant text.
 *
 * Answers how the wait ended: "filled", "timed out", or "ended" -- the turn
 * went idle by itself. The last is not raised here, so the caller's own
 * streaming-at-the-cut check is what fails the run, and says why: an abort
 * sent to a turn that already finished proves nothing about aborting.
 */
export async function waitForTurnToFill(socket: AgentpaneSocket, session: Session, start: number): Promise<string> {
	try {
		return await socket.waitFor(
			(events) => {
				if (assistantChars(turnMessages(events, session, start)) >= ABORT_AT_CHARS) return "filled";
				if (lastStreaming(events, session) === false) return "ended";
				return undefined;
			},
			ABORT_WAIT_SECONDS,
			"the long turn to fill",
		);
	} catch (error) {
		if (error instanceof TimeoutError) return "timed out";
		throw error;
	}
}

// ---------------------------------------------------------------------------
// running the production server
// ---------------------------------------------------------------------------

/**
 * A throwaway backend state dir with real credentials copied in by name.
 *
 * Every backend needs a writable state directory, and its real one may be
 * read-only when this repo's own session is sandboxed; an inner sbox cannot
 * re-mount read-write what the outer namespace mounted read-only. Copying the
 * credentials into a temporary home under /var/tmp is the workaround, and it
 * also keeps a live run from writing into the developer's real store.
 *
 * Contents are never read here, only copied, and the names copied are
 * returned so a run can record what it used without naming what was in it.
 */
export function makeStateHome(realDir: string, names: readonly string[], prefix: string): { home: string; copied: string[] } {
	const home = mkdtempSync(join("/var/tmp", prefix));
	const copied: string[] = [];
	for (const name of names) {
		if (!existsSync(join(realDir, name))) continue;
		copyFileSync(join(realDir, name), join(home, name));
		copied.push(name);
	}
	return { home, copied };
}

/** A fresh path for the server's log, under the system temp dir. */
export function tempLogPath(prefix: string): string {
	return join(mkdtempSync(join("/tmp", prefix)), "server.log");
}

export function buildClient(repo: string): { returncode: number } {
	const built = Bun.spawnSync(["bun", "run", "build"], { cwd: repo, timeout: 180_000 });
	if (built.exitCode !== 0) {
		throw new Error(`client build failed: ${(built.stdout.toString() + built.stderr.toString()).slice(-2000)}`);
	}
	return { returncode: built.exitCode };
}

export type Server = Bun.Subprocess<"ignore", number, number>;

/** `bun run start` in its own process group, stdout and stderr both to `log`. */
export function startServer(repo: string, env: Record<string, string | undefined>, log: string): Server {
	const fd = openSync(log, "w");
	try {
		return Bun.spawn(["bun", "run", "start"], { cwd: repo, env, stdin: "ignore", stdout: fd, stderr: fd, detached: true }) as unknown as Server;
	} finally {
		closeSync(fd);
	}
}

/**
 * Block until the production server serves the built client, or give up.
 *
 * `Accept: text/html` matters: `createStaticHandler` limits the SPA fallback
 * to navigation requests, so a probe without it gets a 404 that looks like a
 * broken build.
 */
export async function waitForBuiltClient(port: number, server: Server, timeoutSeconds: number): Promise<{ http_status: number; has_app_mount: boolean }> {
	const deadline = performance.now() + timeoutSeconds * 1000;
	while (performance.now() < deadline) {
		if (server.exitCode !== null) throw new Error(`server exited during startup with ${server.exitCode}`);
		try {
			const response = await fetch(`http://${HOST}:${port}/`, { headers: { accept: "text/html" } });
			const body = await response.text();
			if (response.status === 200) return { http_status: 200, has_app_mount: body.includes('id="app"') };
		} catch {
			// not listening yet
		}
		await Bun.sleep(100);
	}
	throw new Error("built client was not reachable");
}

/** SIGTERM, then SIGKILL past `graceSeconds`; the exit code. */
export async function stopServer(server: Server, graceSeconds = 15): Promise<number | null> {
	if (server.exitCode === null && server.signalCode === null) {
		server.kill("SIGTERM");
		const exited = await Promise.race([server.exited.then(() => true), Bun.sleep(graceSeconds * 1000).then(() => false)]);
		if (!exited) {
			server.kill("SIGKILL");
			await Promise.race([server.exited, Bun.sleep(5000)]);
		}
	}
	return server.exitCode;
}

export type Evidence = Record<string, unknown> & { result?: string; error?: string };

/**
 * Tear the run down, and treat having done so as a criterion.
 *
 * A run that leaves a live sandboxed agent or a copy of the credentials behind
 * has not passed no matter what its checks said. This runs on the failure path
 * too: that is where leaks actually happen.
 */
export async function finalize(
	evidence: Evidence,
	exitCode: number,
	options: {
		server: Server | undefined;
		sockets: AgentpaneSocket[];
		stateHome: string;
		serverLog: string;
		launchedWorkers: Set<number>;
		workerFilter: (rows: ProcessRow[]) => ProcessRow[];
	},
): Promise<number> {
	const { server, sockets, stateHome, serverLog, launchedWorkers, workerFilter } = options;
	for (const socket of sockets) await socket.close();

	// Enumerate before signalling anything. A run's worker set is only appended
	// to at its checkpoints, so a run that failed elsewhere has an incomplete
	// one -- and once the server is dead its children are reparented and the
	// tree is gone. This is the last moment the set can be completed.
	if (server) {
		for (const row of workerFilter(descendants(server.pid))) launchedWorkers.add(row.pid);
		await stopServer(server);
	}

	const orphaned = await reap(launchedWorkers, 10);
	rmSync(stateHome, { recursive: true, force: true });
	rmSync(resolve(serverLog, ".."), { recursive: true, force: true });
	const cleanup = {
		orphaned_worker_pids: orphaned,
		state_home_removed: !existsSync(stateHome),
		server_log_removed: !existsSync(serverLog),
		result: "pass",
	};
	if (orphaned.length || !cleanup.state_home_removed || !cleanup.server_log_removed) cleanup.result = "fail";
	evidence.cleanup = cleanup;
	if (cleanup.result === "fail" && evidence.result === "pass") {
		evidence.result = "fail";
		evidence.error = `checks passed but cleanup did not: ${JSON.stringify(cleanup)}`;
		return 1;
	}
	return exitCode;
}

/** The tail of the server's log, for a failed run's evidence. */
export function logTail(serverLog: string, chars = 4000): string | undefined {
	try {
		return readFileSync(serverLog, "utf8").slice(-chars);
	} catch {
		return undefined;
	}
}

/** `${error.name}: ${error.message}`, as the Python probes recorded it. */
export function describeError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
