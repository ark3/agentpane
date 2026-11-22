/**
 * A separate process that holds no token cannot get a command run over the
 * socket.
 *
 * What it guards: any process that can reach agentpane's loopback port could
 * once use the whole API, and a sandboxed agent shares the host's loopback
 * (`sbox` keeps the network). Since D31 the API is the socket, whose first
 * frame must be a `hello` carrying the token (D31 point 5), so this acts as a
 * non-browser client with no token and tries two ways in, each on a socket of
 * its own:
 *
 * - `command_first`: the first frame is a `sessions/create` for a Pi session
 *   whose `cwd` is a fresh directory nobody gave it, which since D30 spawns the
 *   agent there.
 * - `wrong_token`: a `hello` with a token of its own making, and behind it,
 *   without waiting, the same create and a `sessions/attach` of a ref, the
 *   route that spawns a stored session.
 *
 * Each case passes when the server closes the socket with
 * `SOCKET_CLOSE.unauthorized` having sent nothing: no event and no reply.
 * In its own-server mode the probe then asks, with the token, for the
 * sessions in the workspace, and looks for a Pi under the server; either one
 * means a command ran.
 *
 * Exit status: **0, pass** when both cases were closed 4401 with nothing sent
 * and nothing was found running. **1, reproduced** when any frame was answered
 * `ok`, or a session or a Pi turned up. **2, inconclusive** on anything else --
 * another close code, a refusal reply, a socket that never opened -- which
 * shows neither refusal nor access. **3** means the verdict stands but the run
 * could not close a session it started or clean up after itself.
 *
 * Two modes:
 *
 * - **Default.** Builds the client (unless `--skip-build`) and starts its own
 *   production server from this checkout on a port the OS picks, with Pi
 *   given a throwaway state directory through `PI_CODING_AGENT_DIR`. The
 *   server is stopped at the end.
 * - **`--base-url URL`.** Starts no server and targets one already running,
 *   for instance one started outside `sbox` while this probe runs inside it.
 *   No listing is asked, since the token this probe could read inside `sbox`
 *   is the sandbox's own, so the two cases' closes are the whole evidence.
 *
 * The workspace is a fresh directory under `/var/tmp` holding an empty
 * `.sandbox-workspace`, because `sbox` refuses as a workspace a directory with
 * neither a marker file nor a git root, and a create whose agent exits at once
 * would be inconclusive; `sbox` binds `/var/tmp` read-write from the host, so
 * a server outside the probe's sandbox sees the same directory.
 *
 * The create carries the pinned `model`, as the Pi smoke sends, but nothing is
 * prompted, so no model is charged.
 *
 * Usage:  bun resources/probes/loopback_token_repro_probe.ts [--skip-build] [--base-url http://127.0.0.1:PORT]
 *           [--app-root DIR] [--credential-source DIR] [--model REF]
 * Ported from `loopback_token_repro_probe.py`, which asked the same over the
 * HTTP routes (ark3/agentpane#54).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { SOCKET_CLOSE, type SessionRef } from "../../src/shared/protocol.ts";
import {
	AgentpaneSocket,
	HOST,
	REPO,
	type Reply,
	type Server,
	alive,
	buildClient,
	cliVersion,
	describeError,
	descendants,
	finalize,
	logTail,
	makeStateHome,
	now,
	sleep,
	startServer,
	tempLogPath,
	waitForBuiltClient,
	withTimeout,
} from "./agentpane_live_support.ts";
import { PI_STATE_FILES, PINNED_MODEL, piWorkers } from "./agentpane_pi_smoke.ts";

const EXIT_PASS = 0;
const EXIT_REPRODUCED = 1;
const EXIT_INCONCLUSIVE = 2;
const EXIT_CLEANUP_FAILED = 3;

/** Attached in `wrong_token`: with the token required it is refused before any lookup. */
const PLACEHOLDER_REF: SessionRef = { backend: "pi", id: "virtual:loopback-token-repro-probe" };

/** How long a case waits for the server to close its socket. */
const CLOSE_WAIT_SECONDS = 10;

function parseArguments() {
	return parseArgs({
		options: {
			"base-url": { type: "string" },
			"app-root": { type: "string", default: REPO },
			"skip-build": { type: "boolean", default: false },
			"credential-source": { type: "string", default: join(homedir(), ".pi", "agent") },
			model: { type: "string", default: PINNED_MODEL },
		},
	}).values;
}

/** A port the OS has just handed out; released before the server binds it, so a start can still lose a race for it. */
function freePort(): number {
	const probe = Bun.serve({ hostname: HOST, port: 0, fetch: () => new Response() });
	const port = probe.port!;
	probe.stop(true);
	return port;
}

interface Case {
	sent: string[];
	replies: Record<string, Reply>;
	events_received: number;
	close: { code: number; reason: string } | "still open" | undefined;
	error?: string;
}

/**
 * One socket, the frames `send` writes on it, and everything the server
 * answered before it closed the socket or `CLOSE_WAIT_SECONDS` passed.
 */
async function attempt(host: string, port: number, send: (socket: AgentpaneSocket) => Promise<Reply>[], sent: string[]): Promise<Case> {
	const result: Case = { sent, replies: {}, events_received: 0, close: undefined };
	let socket: AgentpaneSocket;
	try {
		socket = await AgentpaneSocket.connect(port, host);
	} catch (error) {
		result.error = describeError(error);
		return result;
	}
	const replies = send(socket);
	result.close = await withTimeout(socket.closing, CLOSE_WAIT_SECONDS, "the server to close the socket").catch(() => "still open" as const);
	// A socket that closed settles every request still out as `connection_lost`.
	const settled = await Promise.allSettled(replies);
	settled.forEach((outcome, index) => {
		result.replies[sent[index]!] =
			outcome.status === "fulfilled" ? outcome.value : { ok: false, code: "no_reply", detail: describeError(outcome.reason) };
	});
	result.events_received = socket.events.length;
	await socket.close();
	return result;
}

function refused(result: Case): boolean {
	return (
		typeof result.close === "object" &&
		result.close.code === SOCKET_CLOSE.unauthorized &&
		result.events_received === 0 &&
		Object.values(result.replies).every((reply) => !reply.ok && reply.code === "connection_lost")
	);
}

function answered(result: Case): boolean {
	return result.events_received > 0 || Object.values(result.replies).some((reply) => reply.ok);
}

async function main(): Promise<number> {
	const args = parseArguments();
	const workspace = mkdtempSync(join("/var/tmp", "agentpane-loopback-ws-"));
	writeFileSync(join(workspace, ".sandbox-workspace"), "");
	const evidence: Record<string, unknown> = {
		started_at: now(),
		mode: args["base-url"] ? "base-url" : "own server",
		workspace,
		model_flag: args.model,
		headers_sent: "none beyond what Bun's WebSocket client sends on the upgrade; no Origin, no token",
	};

	let server: Server | undefined;
	let stateHome: string | undefined;
	let serverLog: string | undefined;
	const launchedWorkers = new Set<number>();
	const cases: Record<string, Case> = {};
	evidence.cases = cases;
	let found: { sessions: number; pi_pids: number[] } | undefined;
	let closeOk = true;
	let host = HOST;
	let port = 0;

	try {
		if (args["base-url"]) {
			const url = new URL(args["base-url"]);
			if (url.protocol !== "http:" || !url.port) throw new Error(`--base-url must be http://host:port, got ${args["base-url"]}`);
			host = url.hostname;
			port = Number(url.port);
		} else {
			const repo = resolve(args["app-root"]!);
			if (!existsSync(join(repo, "package.json"))) throw new Error(`not an agentpane checkout: ${repo}`);
			port = freePort();
			const state = makeStateHome(resolve(args["credential-source"]!), PI_STATE_FILES, "agentpane-loopback-pihome-");
			stateHome = state.home;
			evidence.pi_state = { temporary_state_home: state.home, copied_files: state.copied };
			if (!state.copied.includes("auth.json")) throw new Error(`missing Pi credentials under ${args["credential-source"]}`);
			evidence.pi_version = cliVersion("pi");
			if (!args["skip-build"]) evidence.build = buildClient(repo);
			serverLog = tempLogPath("agentpane-loopback-server-");
			server = startServer(repo, { ...process.env, PI_CODING_AGENT_DIR: state.home, PORT: String(port) }, serverLog);
			evidence.server_pid = server.pid;
			await waitForBuiltClient(port, server, 20);
		}
		evidence.target = `ws://${host}:${port}`;
		const create = { cwd: workspace, backend: "pi" as const, model: args.model! };

		cases.command_first = await attempt(host, port, (socket) => [socket.request("sessions/create", create, CLOSE_WAIT_SECONDS + 5)], ["sessions/create"]);

		const wrongToken = randomBytes(32).toString("base64url");
		cases.wrong_token = await attempt(
			host,
			port,
			(socket) => [
				socket.request("hello", { token: wrongToken }, CLOSE_WAIT_SECONDS + 5),
				socket.request("sessions/create", create, CLOSE_WAIT_SECONDS + 5),
				socket.request("sessions/attach", { ref: PLACEHOLDER_REF }, CLOSE_WAIT_SECONDS + 5),
			],
			["hello", "sessions/create", "sessions/attach"],
		);

		// Only a server this run started holds a token this probe can read, and
		// a tree it may inspect.
		if (server) {
			const owner = await AgentpaneSocket.open(port, host);
			const listing = await owner.ok("sessions/list", { cwd: workspace });
			const pids = piWorkers(descendants(server.pid)).map((row) => row.pid);
			for (const pid of pids) launchedWorkers.add(pid);
			found = { sessions: listing.sessions.length, pi_pids: pids };
			evidence.found_with_the_token = { at: now(), sessions: listing.sessions.map((row) => ({ ref: row.ref, status: row.status })), pi_pids: pids };
			// Close what a command started, so no agent is left running: each
			// live row, by its handle (D35 point 3).
			for (const row of listing.sessions) {
				if (row.handle === undefined) continue;
				const closed = await owner.request("sessions/close", { handle: row.handle });
				closeOk &&= closed.ok;
			}
			if (pids.length) {
				const deadline = performance.now() + 10_000;
				while (alive(launchedWorkers).length && performance.now() < deadline) await sleep(0.1);
				evidence.pi_pids_alive_after_close = alive(launchedWorkers);
				closeOk &&= alive(launchedWorkers).length === 0;
			}
			await owner.close();
		}
	} catch (error) {
		evidence.error = describeError(error);
		if (serverLog) evidence.server_log_tail = logTail(serverLog);
	}

	const results = Object.values(cases);
	let verdict: string;
	let exitCode: number;
	if (results.some(answered) || (found && (found.sessions > 0 || found.pi_pids.length > 0))) {
		[verdict, exitCode] = ["fails: a frame without the token was answered or ran", EXIT_REPRODUCED];
	} else if (results.length === 2 && results.every(refused) && !evidence.error) {
		[verdict, exitCode] = ["passes: both sockets closed 4401 with nothing sent", EXIT_PASS];
	} else {
		[verdict, exitCode] = ["inconclusive", EXIT_INCONCLUSIVE];
	}
	evidence.verdict = verdict;

	let cleanupOk = closeOk;
	if (server && stateHome && serverLog) {
		// `finalize` only rewrites a `result` key, which this probe does not
		// use: its verdict is not pass/fail in the smoke probes' sense.
		await finalize(evidence, exitCode, { server, sockets: [], stateHome, serverLog, launchedWorkers, workerFilter: piWorkers });
		cleanupOk &&= (evidence.cleanup as { result: string }).result === "pass";
	} else {
		if (stateHome) rmSync(stateHome, { recursive: true, force: true });
		if (serverLog) rmSync(resolve(serverLog, ".."), { recursive: true, force: true });
	}
	rmSync(workspace, { recursive: true, force: true });
	evidence.workspace_removed = !existsSync(workspace);
	cleanupOk &&= evidence.workspace_removed as boolean;
	evidence.session_closed_and_cleaned_up = cleanupOk;
	evidence.finished_at = now();

	console.log(JSON.stringify(evidence, null, 2));
	const closes = Object.entries(cases).map(([name, result]) => `${name}: ${typeof result.close === "object" ? result.close.code : result.close}`);
	console.log(`\n${closes.join("; ")}; ${verdict}`);
	if (!cleanupOk) {
		console.log("cleanup did not complete; see found_with_the_token, pi_pids_alive_after_close and cleanup above");
		return EXIT_CLEANUP_FAILED;
	}
	return exitCode;
}

if (import.meta.main) process.exit(await main());
