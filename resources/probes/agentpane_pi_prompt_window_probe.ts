/**
 * What agentpane makes of a Pi prompt in a run's starting window, and of one
 * an extension handles (OW-kokotu), through the built server and its socket
 * (D31).
 *
 * The questions, opened by Pi's changelog rather than by anything run:
 *
 * - `pi 1.2.0` counts a session busy from the moment a run starts, before
 *   `agent_start`. `PiAdapter.submit` in `src/server/adapters/pi/process.ts`
 *   added `streamingBehavior: "steer"` only once the reducer had seen
 *   `agent_start`, so a second prompt in that window went out bare. Since
 *   OW-wibude it sends "steer" on every prompt.
 * - `pi 0.99.0` answers a successful `prompt` with `data.disposition`, and
 *   `"handled"` means no run started, so no `agent_settled` follows. Since
 *   OW-dulipe a prompt's reply carries that disposition.
 *
 * What Pi alone answers to the same window, and the steer-then-abort cells,
 * are the `rpc` and `steer_abort` parts of `agentpane_pi_prompt_window_probe.py`,
 * which drive `pi --mode rpc` directly. This was its `agentpane` part, over
 * HTTP and the event stream, until ark3/agentpane#54 moved it here.
 *
 * It drives the real chain -- `direnv exec <workspace> sbox -- pi --mode rpc
 * --model <pinned>`, spawned by agentpane's built server -- by `sessions/prompt`
 * naming the create's handle, with a `pi` shim first on the server's PATH that
 * copies Pi's stdin and stdout to two tap files, as `agentpane_pi_steer_probe.ts`
 * copies its stdout. The stdin tap is what shows whether a prompt carried
 * `streamingBehavior`. Cells:
 *
 * - `concurrent_prompts`: two prompt frames written back to back on the one
 *   socket, neither awaited; the server runs a socket's commands as they
 *   arrive, so they meet in the session's queue as two POSTs released
 *   together from two threads did.
 * - `prompt_after_reply`: the second prompt sent the moment the first's reply
 *   arrives.
 * - `handled_<name>`: each extension command, named by `--command` (default
 *   `mcp`), as a prompt, then `HANDLED_WAIT` seconds of the socket's events,
 *   then an ordinary prompt to show what follows. Which commands Pi lists is
 *   the Python part `rpc`'s `get_commands`; agentpane does not relay it.
 *
 * Each reply is recorded as its result or its refusal code, where the Python
 * part recorded HTTP statuses.
 *
 * ## The configuration
 *
 * "Stock" is this machine's: `PI_CODING_AGENT_DIR` points at a temporary copy
 * of `~/.pi/agent` holding the credential and settings files by name and the
 * `extensions/` directory dereferenced, so the user extensions installed there
 * load as they would for agentpane, and Pi's built-in extensions load as they
 * do by default. The copy keeps the runs out of the real session store. The
 * workspace is a fresh directory under `/var/tmp` carrying only the
 * `.sandbox-workspace` marker sbox needs, so no project `AGENTS.md`, `.pi/` or
 * prompt template is in play.
 *
 * Every model call is pinned by `--model` (AGENTS.md) and each prompt asks for
 * one word. This makes real model calls, never invokes Codex or Claude, copies
 * Pi credentials by name without reading them, and signals only pids it
 * recorded as its own.
 *
 * It records rather than asserts: `result` is `pass` when every cell ran and
 * cleanup passed, whatever the cells recorded.
 *
 * Usage:  bun resources/probes/agentpane_pi_prompt_window_probe.ts [--app-root DIR]
 *           [--port N] [--model REF] [--credential-source DIR] [--command NAME ...] [--skip-build]
 * Prints the evidence as JSON; exits 0 when it ran to the end, 1 otherwise.
 */

import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
	AgentpaneSocket,
	type Evidence,
	type ProcessRow,
	REPO,
	type Reply,
	type Server,
	type Stamped,
	type WireEvent,
	buildClient,
	cliVersion,
	compactTree,
	describeError,
	descendants,
	finalize,
	idleAfterStreaming,
	lastStreaming,
	logTail,
	makeStateHome,
	now,
	sleep,
	startServer,
	tempLogPath,
	transcript,
	waitForBuiltClient,
} from "./agentpane_live_support.ts";
import { PINNED_MODEL, PI_STATE_FILES } from "./agentpane_pi_smoke.ts";

const PORT = 44179;
const HANDLED_WAIT = 5;
const QUIET = 2;

export function word(w: string): string {
	return `Reply with exactly the single word ${w} and nothing else. Do not use tools.`;
}

/** `makeStateHome`'s copy, plus `extensions/` dereferenced; the extensions' names are returned beside the files'. */
export function makePiHome(source: string, prefix: string): { home: string; copied: string[]; extensions: string[] } {
	const { home, copied } = makeStateHome(source, PI_STATE_FILES, prefix);
	let extensions: string[] = [];
	if (existsSync(join(source, "extensions"))) {
		cpSync(join(source, "extensions"), join(home, "extensions"), { recursive: true, dereference: true });
		extensions = readdirSync(join(home, "extensions")).sort();
	}
	return { home, copied, extensions };
}

export function makeWorkspace(prefix: string): string {
	const workspace = mkdtempSync(join("/var/tmp", prefix));
	writeFileSync(join(workspace, ".sandbox-workspace"), "");
	return workspace;
}

export function userText(message: Record<string, any>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return (content ?? []).filter((block: any) => block && typeof block === "object").map((block: any) => block.text ?? "").join("");
}

function pick(event: Record<string, any>, keys: string[]): Record<string, unknown> {
	return Object.fromEntries(keys.map((key) => [key, event[key]]));
}

/** A Pi RPC line with the deltas and payloads cut down to what these probes read. */
export function summarise(event: Record<string, any>): Record<string, unknown> {
	const kind = event.type;
	const row: Record<string, unknown> = { type: kind };
	if (kind === "response") {
		Object.assign(row, pick(event, ["id", "command", "success"]));
		if (event.success) {
			if (["prompt", "steer", "follow_up"].includes(event.command)) row.data = event.data;
		} else {
			row.error = event.error;
		}
	} else if (kind === "message_start" || kind === "message_end") {
		const message = event.message ?? {};
		row.role = message.role;
		if (message.role === "user") row.text = userText(message);
		if (message.role === "assistant") row.stopReason = message.stopReason;
	} else if (kind === "extension_ui_request") {
		Object.assign(row, pick(event, ["method", "message", "notifyType", "statusKey", "title"]));
	} else if (kind === "queue_update") {
		Object.assign(row, pick(event, ["steering", "followUp"]));
	} else if (kind === "extension_error") {
		Object.assign(row, pick(event, ["extensionPath", "event", "error"]));
	}
	return row;
}

/**
 * A `pi` that is the real `pi` with its stdin and stdout copied to two taps,
 * all three in one fresh directory under /tmp.
 *
 * As `agentpane_pi_steer_probe.ts`'s shim, plus a `tee` on stdin: /tmp is
 * mounted read-write inside sbox on the home server, and the shim is found
 * because the server's PATH names its directory first. Pi's exit status does
 * not pass through, which this probe never reads.
 */
export function makeShim(realPi: string, prefix: string): { dir: string; tapIn: string; tapOut: string } {
	const dir = mkdtempSync(join("/tmp", prefix));
	const tapIn = join(dir, "stdin.jsonl");
	const tapOut = join(dir, "stdout.jsonl");
	writeFileSync(tapIn, "");
	writeFileSync(tapOut, "");
	const script = join(dir, "pi");
	writeFileSync(script, `#!/bin/sh\ntee -a "${tapIn}" | "${realPi}" "$@" | tee -a "${tapOut}"\n`);
	chmodSync(script, 0o755);
	return { dir, tapIn, tapOut };
}

/** This run's agent-side processes: Pi, the two `tee`s, and the wrappers. */
export function shimWorkers(rows: ProcessRow[]): ProcessRow[] {
	return rows.filter((row) => row.comm === "pi" || row.comm === "tee" || ((row.comm === "node" || row.comm === "sh") && row.cmd.includes("--mode rpc")));
}

/** Every line on a tap so far, parsed where it is JSON. */
export function readTap(tap: string): Record<string, any>[] {
	if (!existsSync(tap)) return [];
	return readFileSync(tap, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { type: "<unparsed>", raw: line.slice(0, 200) };
			}
		});
}

/** The socket's events under `handle` since `start`, cut down, with runs of upserts at one index counted. */
export function wireRows(events: Stamped[], start: number, handle: string): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	for (const [stamp, event] of events.slice(start)) {
		if (event.handle !== handle) continue;
		const kind = event.type;
		const row: Record<string, unknown> = { at: stamp, type: kind };
		if (kind === "snapshot" || kind === "status") {
			row.isStreaming = event.isStreaming;
		} else if (kind === "upsert") {
			const message = event.message ?? {};
			row.index = event.index;
			row.role = message.role;
			if (message.role === "user") row.text = userText(message);
			const last = rows.at(-1);
			if (last?.type === "upsert" && last.index === row.index) {
				last.count = ((last.count as number | undefined) ?? 1) + 1;
				continue;
			}
		} else if (kind === "error") {
			row.message = event.message;
		} else if (kind === "notice") {
			const notice = event.notice ?? {};
			row.kind = notice.kind;
			row.message = notice.message;
		}
		rows.push(row);
	}
	return rows;
}

/** A reply as evidence: its result, or its refusal's code and detail. */
export function replyEvidence(reply: Reply): Record<string, unknown> {
	return reply.ok ? { ok: true, result: reply.result } : { ok: false, code: reply.code, detail: reply.detail, ...(reply.fork ? { fork: reply.fork } : {}) };
}

/** The model the session last reported on the wire, which is what `--model` put in force. */
export function modelOnWire(events: Stamped[], handle: string): unknown {
	return [...events].reverse().find(([, event]) => event.handle === handle && (event.type === "snapshot" || event.type === "status") && event.model)?.[1].model ?? null;
}

function parseArguments() {
	return parseArgs({
		options: {
			"app-root": { type: "string", default: REPO },
			port: { type: "string", default: String(PORT) },
			model: { type: "string", default: PINNED_MODEL },
			"credential-source": { type: "string", default: join(homedir(), ".pi", "agent") },
			command: { type: "string", multiple: true, default: ["mcp"] },
			"skip-build": { type: "boolean", default: false },
		},
	}).values;
}

async function main(): Promise<number> {
	const args = parseArguments();
	const repo = resolve(args["app-root"]!);
	const port = Number(args.port);
	const model = args.model!;
	const pi = Bun.which("pi");
	if (!pi) throw new Error("pi is not on PATH");

	const { home, copied, extensions } = makePiHome(resolve(args["credential-source"]!), "agentpane-window-pihome-");
	const workspace = makeWorkspace("agentpane-window-ws-");
	const shim = makeShim(realpathSync(pi), "agentpane-window-shim-");
	const serverLog = tempLogPath("agentpane-window-server-");
	let server: Server | undefined;
	const sockets: AgentpaneSocket[] = [];
	const launched = new Set<number>();
	const evidence: Evidence = {
		started_at: now(),
		probe: "agentpane_pi_prompt_window_probe.ts",
		card: "OW-kokotu",
		commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim(),
		pi_version: cliVersion("pi"),
		model_flag: model,
		copied_state_files: copied,
		copied_extensions: extensions,
		workspace,
	};
	let exitCode = 1;
	try {
		if (!copied.includes("auth.json")) throw new Error(`missing Pi credentials under ${args["credential-source"]}`);
		if (!args["skip-build"]) evidence.build = buildClient(repo);
		server = startServer(repo, { ...process.env, PATH: `${shim.dir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: home, PORT: String(port) }, serverLog);
		evidence.server_pid = server.pid;
		await waitForBuiltClient(port, server, 30);
		const socket = await AgentpaneSocket.open(port);
		sockets.push(socket);

		// The create starts the session and answers as an attach does (D30).
		const created = await socket.request("sessions/create", { cwd: workspace, backend: "pi", model }, 120);
		if (!created.ok) throw new Error(`create failed: ${created.code} ${created.detail}`);
		const handle = created.result.session.handle;
		const tree = descendants(server.pid);
		for (const row of shimWorkers(tree)) launched.add(row.pid);
		evidence.process_chain = compactTree(tree).map((row) => row.comm);
		evidence.model_on_wire = modelOnWire(socket.snapshot(), handle);

		async function idleAfter(start: number): Promise<void> {
			await socket.waitFor((events) => idleAfterStreaming(events, handle, start), 120, "the session to stream and go idle");
			await sleep(QUIET);
		}

		type Sent = { reply: Reply<"sessions/prompt">; sent: number; replied: number };
		async function prompt(text: string): Promise<Sent> {
			const sent = performance.now();
			const reply = await socket.request("sessions/prompt", { handle, text });
			return { reply, sent, replied: performance.now() };
		}

		async function cell(name: string, fire: () => Promise<Sent[]>, wait: (start: number) => Promise<void>): Promise<void> {
			const wireStart = socket.events.length;
			const inStart = readTap(shim.tapIn).length;
			const outStart = readTap(shim.tapOut).length;
			const t0 = performance.now();
			const replies = await fire();
			await wait(wireStart);
			const events = socket.snapshot();
			evidence[name] = {
				prompts: replies.map((r) => ({
					reply: replyEvidence(r.reply),
					sent_s: Number(((r.sent - t0) / 1000).toFixed(4)),
					replied_s: Number(((r.replied - t0) / 1000).toFixed(4)),
				})),
				pi_stdin_prompts: readTap(shim.tapIn)
					.slice(inStart)
					.filter((command) => command.type === "prompt")
					.map((command) => pick(command, ["id", "type", "message", "streamingBehavior"])),
				pi_stdout: readTap(shim.tapOut)
					.slice(outStart)
					.filter((line) => line.type !== "message_update")
					.map(summarise),
				wire: wireRows(events, wireStart, handle),
				last_streaming: lastStreaming(events, handle) ?? null,
				user_messages_in_transcript: transcript(events, handle)
					.filter((message: WireEvent) => message.role === "user")
					.map(userText),
			};
		}

		// Settle the create's own events first.
		await sleep(QUIET);

		await cell("concurrent_prompts", () => Promise.all([prompt(word("ALPHA")), prompt(word("BRAVO"))]), idleAfter);
		await cell("prompt_after_reply", async () => {
			const first = await prompt(word("CHARLIE"));
			return [first, await prompt(word("DELTA"))];
		}, idleAfter);
		for (const name of args.command!) {
			await cell(`handled_${name}`, async () => [await prompt(`/${name}`)], () => sleep(HANDLED_WAIT));
			await cell(`after_handled_${name}`, async () => [await prompt(word("ECHO"))], idleAfter);
		}

		evidence.result = "pass";
		exitCode = 0;
	} catch (error) {
		evidence.result = "fail";
		evidence.error = describeError(error);
		evidence.server_log_tail = logTail(serverLog);
		exitCode = 1;
	} finally {
		// `finalize` removes the Pi home it is given, so nothing else here does.
		exitCode = await finalize(evidence, exitCode, { server, sockets, stateHome: home, serverLog, launchedWorkers: launched, workerFilter: shimWorkers });
		rmSync(shim.dir, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
		evidence.finished_at = now();
	}
	console.log(JSON.stringify(evidence, null, 2));
	return exitCode;
}

if (import.meta.main) process.exit(await main());
