/**
 * What agentpane's fork-and-prompt answers on Pi before the first assistant
 * reply, and when the fork's file reaches disk (OW-tigaye), through the built
 * server and its socket (D31).
 *
 * When Pi alone writes a new session's file and a fork's, and what its `fork`
 * answers before any prompt and during the first turn, is the `rpc` part of
 * `agentpane_pi_fork_first_turn_probe.py`, which drives `pi --mode rpc`
 * directly. This was its `agentpane` part, over HTTP and the event stream,
 * until ark3/agentpane#54 moved it here. That part drove the fork route alone,
 * which the socket keeps but neither client sends since D30 made an edit one
 * operation, so each fork here is a `sessions/forkAndPrompt`, which forks at a
 * fork point's transcript index, attaches the fork under its own handle, and
 * prompts it. The fork route aborted nothing before it forked when the Python
 * part first ran; since ark3/agentpane#47 `PiAdapter.fork` sends `clear_queue`
 * and `abort` first, so `fork_first_turn` forks a stopped turn.
 *
 * The real chain, `direnv exec <workspace> sbox -- pi --mode rpc --model
 * <pinned>` spawned by the built server, with the prompt-window probe's `pi`
 * shim first on its PATH, teeing Pi's stdin and stdout to two tap files. The
 * session is created, prompted and forked by the create's handle.
 *
 * - `fork_before_prompt`: `sessions/forkPoints`, then a fork-and-prompt at an
 *   index no fork point has, which is refused before anything reaches Pi (D20),
 *   where the Python part's fork at an entry no session has reached Pi's
 *   refusal; then the session's listing row and a re-attach.
 * - `fork_first_turn`: a long prompt; once the turn's assistant text passes
 *   `FORK_AT_CHARS` with the session still streaming, `sessions/forkPoints` and
 *   a fork-and-prompt at the first user message, whose text is the one-word
 *   prompt the Python part then sent to the fork. The fork's file is stat'ed
 *   the moment the reply is read, which is once the fork's prompt is admitted.
 *   Then the fork's turn, with the fork's file read before and after it.
 *
 * Nothing after a fork asks the session index or re-attaches the parent:
 * the relocated `PI_CODING_AGENT_DIR` moves Pi's store and not the server's,
 * which walks `~/.pi/agent/sessions` whatever the variable says
 * (`src/server/sessions/index.ts`), so the index cannot see a file this run
 * writes, and a re-attach of the parent answered 404 on a first pass with its
 * file on disk -- the harness defect `docs/MANUAL_TESTING.md` records in
 * "Forking the most recent turn and attaching the fork, on all three backends
 * (OW-lajehi)". The listing rows read before any prompt and as the fork
 * attaches are the manager's own, for sessions still attached.
 *
 * Each reply is recorded as its result or its refusal code, where the Python
 * part recorded HTTP statuses. The configuration is the prompt-window probe's.
 * It records rather than asserts: `result` is `pass` when every cell ran and
 * cleanup passed, whatever the cells recorded.
 *
 * Usage:  bun resources/probes/agentpane_pi_fork_first_turn_probe.ts [--app-root DIR]
 *           [--port N] [--model REF] [--credential-source DIR] [--skip-build]
 * Prints the evidence as JSON; exits 0 when it ran to the end, 1 otherwise.
 */

import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
	AgentpaneSocket,
	type Evidence,
	LONG_PROMPT,
	REPO,
	type Server,
	assistantText,
	buildClient,
	cliVersion,
	describeError,
	descendants,
	finalize,
	idleAfterStreaming,
	lastStreaming,
	logTail,
	now,
	sleep,
	startServer,
	tempLogPath,
	transcript,
	waitForBuiltClient,
} from "./agentpane_live_support.ts";
import { PINNED_MODEL } from "./agentpane_pi_smoke.ts";
import {
	makePiHome,
	makeShim,
	makeWorkspace,
	modelOnWire,
	readTap,
	replyEvidence,
	shimWorkers,
	summarise,
	wireRows,
	word,
} from "./agentpane_pi_prompt_window_probe.ts";

const PORT = 44178;
const FORK_AT_CHARS = 300;
/** An index no fork point names: before any prompt there are none. */
const NO_SUCH_INDEX = 9999;

/** A session file as its entry kinds, assistant text lengths alongside. */
function entriesOf(path: string | undefined): Record<string, unknown> {
	if (!path || !existsSync(path)) return { exists: false };
	const entries = readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const entry = JSON.parse(line);
			let kind: string = entry.type ?? "?";
			if (kind === "message") {
				const role = entry.message?.role;
				kind = `message:${role}`;
				if (role === "assistant") kind += `(${assistantText(entry.message).length})`;
			}
			return kind;
		});
	return { exists: true, bytes: statSync(path).size, entries };
}

function parseArguments() {
	return parseArgs({
		options: {
			"app-root": { type: "string", default: REPO },
			port: { type: "string", default: String(PORT) },
			model: { type: "string", default: PINNED_MODEL },
			"credential-source": { type: "string", default: join(homedir(), ".pi", "agent") },
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

	const { home, copied, extensions } = makePiHome(resolve(args["credential-source"]!), "agentpane-tigaye-pihome-");
	const workspace = makeWorkspace("agentpane-tigaye-ws-");
	const shim = makeShim(realpathSync(pi), "agentpane-tigaye-shim-");
	const serverLog = tempLogPath("agentpane-tigaye-server-");
	let server: Server | undefined;
	const sockets: AgentpaneSocket[] = [];
	const launched = new Set<number>();
	const evidence: Evidence = {
		started_at: now(),
		probe: "agentpane_pi_fork_first_turn_probe.ts",
		card: "OW-tigaye",
		commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim(),
		pi_version: cliVersion("pi"),
		model_flag: model,
		copied_state_files: copied,
		copied_extensions: extensions,
	};
	let exitCode = 1;

	function piLines(start: number, kinds?: string[]) {
		return readTap(shim.tapOut)
			.slice(start)
			.filter((line) => line.type !== "message_update" && (!kinds || kinds.includes(line.type)))
			.map(summarise);
	}

	/** What Pi was sent since `start`: each command's id and type, and a fork's entry. */
	function piCommands(start: number) {
		return readTap(shim.tapIn)
			.slice(start)
			.map((command) => ({ id: command.id, type: command.type, ...(command.entryId ? { entryId: command.entryId } : {}) }));
	}

	try {
		if (!copied.includes("auth.json")) throw new Error(`missing Pi credentials under ${args["credential-source"]}`);
		if (!args["skip-build"]) evidence.build = buildClient(repo);
		server = startServer(repo, { ...process.env, PATH: `${shim.dir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: home, PORT: String(port) }, serverLog);
		evidence.server_pid = server.pid;
		await waitForBuiltClient(port, server, 30);
		const socket = await AgentpaneSocket.open(port);
		sockets.push(socket);
		const serverPid = server.pid;

		function track(): void {
			for (const row of shimWorkers(descendants(serverPid))) launched.add(row.pid);
		}

		async function summary(ref: { backend: string; id: string }) {
			const reply = await socket.request("sessions/list", { cwd: workspace });
			if (!reply.ok) return replyEvidence(reply);
			const row = reply.result.sessions.find((session) => session.ref.backend === ref.backend && session.ref.id === ref.id);
			return row ? { status: row.status, isStreaming: row.isStreaming, onDisk: row.onDisk, preview: row.preview } : null;
		}

		function live(session: { ref: unknown; handle: string; isStreaming: boolean; onDisk: boolean }) {
			return { ref: session.ref, handle: session.handle, isStreaming: session.isStreaming, onDisk: session.onDisk };
		}

		// -- a session, forked before its first prompt ------------------------
		// The create starts the session and answers as an attach does (D30).
		const created = await socket.request("sessions/create", { cwd: workspace, backend: "pi", model }, 120);
		if (!created.ok) throw new Error(`create failed: ${created.code} ${created.detail}`);
		track();
		const { ref, handle } = created.result.session;
		evidence.create = { ...live(created.result.session), file_exists: existsSync(ref.id) };
		evidence.model_on_wire = modelOnWire(socket.snapshot(), handle);
		await sleep(2);

		{
			const wire0 = socket.events.length;
			const in0 = readTap(shim.tapIn).length;
			const out0 = readTap(shim.tapOut).length;
			const cell: Record<string, unknown> = {};
			cell.fork_points = replyEvidence(await socket.request("sessions/forkPoints", { handle }));
			cell.fork_and_prompt = replyEvidence(
				await socket.request("sessions/forkAndPrompt", { handle, index: NO_SUCH_INDEX, text: word("ALPHA") }),
			);
			await sleep(2);
			cell.pi_stdin = piCommands(in0);
			cell.pi_stdout = piLines(out0);
			cell.wire = wireRows(socket.snapshot(), wire0, handle);
			cell.summary_after = await summary(ref);
			const reattach = await socket.request("sessions/attach", { ref }, 120);
			track();
			cell.reattach = reattach.ok ? { ok: true, ...live(reattach.result.session) } : replyEvidence(reattach);
			cell.file_exists_after = existsSync(ref.id);
			evidence.fork_before_prompt = cell;
		}

		// -- the same session, forked during its first turn -------------------
		const cell: Record<string, unknown> = {};
		evidence.fork_first_turn = cell;
		const wire0 = socket.events.length;
		const in0 = readTap(shim.tapIn).length;
		const out0 = readTap(shim.tapOut).length;
		cell.prompt = replyEvidence(await socket.request("sessions/prompt", { handle, text: LONG_PROMPT }));
		cell.assistant_chars_before_fork_points = await socket.waitFor(
			(events) => {
				if (lastStreaming(events, handle) !== true) return undefined;
				const chars = transcript(events, handle).reduce((total, message) => total + assistantText(message).length, 0);
				return chars >= FORK_AT_CHARS ? chars : undefined;
			},
			180,
			"the first turn's text",
		);
		const points = await socket.request("sessions/forkPoints", { handle });
		cell.fork_points = replyEvidence(points);
		cell.assistant_message_end_on_wire_before_fork = readTap(shim.tapOut)
			.slice(out0)
			.some((line) => line.type === "message_end" && line.message?.role === "assistant");
		cell.parent_exists_before_fork = existsSync(ref.id);
		if (!points.ok || !points.result.points[0]) throw new Error(`no fork point during the first turn: ${JSON.stringify(cell.fork_points)}`);
		const forkCut = socket.events.length;
		const sent = performance.now();
		const forked = await socket.request("sessions/forkAndPrompt", { handle, index: points.result.points[0].index, text: word("ALPHA") }, 120);
		const seconds = Number(((performance.now() - sent) / 1000).toFixed(3));
		const forkRef = forked.ok ? forked.result.session.ref : undefined;
		cell.fork_and_prompt = {
			reply: forked.ok ? { ok: true, disposition: forked.result.disposition, session: live(forked.result.session) } : replyEvidence(forked),
			seconds,
			fork_file_exists_at_reply: !!forkRef && existsSync(forkRef.id),
			parent_file_at_reply: entriesOf(ref.id),
		};
		track();
		await sleep(3);
		cell.pi_stdin_from_prompt = piCommands(in0);
		cell.pi_stdout_from_prompt = piLines(out0, ["response", "agent_start", "agent_end", "agent_settled", "message_start", "message_end"]);
		cell.wire_parent_handle = wireRows(socket.snapshot(), wire0, handle);
		if (!forked.ok || !forkRef) throw new Error(`fork-and-prompt failed: ${JSON.stringify(cell.fork_and_prompt)}`);

		// -- the fork's turn ----------------------------------------------------
		const forkHandle = forked.result.session.handle;
		const after: Record<string, unknown> = {
			fork_file_after_3s: entriesOf(forkRef.id),
			fork_summary: await summary(forkRef),
		};
		evidence.after_fork = after;
		await socket.waitFor((events) => idleAfterStreaming(events, forkHandle, forkCut), 120, "the fork's turn to stream and go idle");
		await sleep(2);
		after.fork_transcript_roles = transcript(socket.snapshot(), forkHandle).map((message) => message.role);
		after.fork_file_after_turn = entriesOf(forkRef.id);
		const forkWire = wireRows(socket.snapshot(), forkCut, forkHandle);
		after.fork_wire = forkWire.filter((row) => row.type !== "upsert");
		after.fork_wire_errors = forkWire.filter((row) => row.type === "error");
		after.fork_wire_notices = forkWire.filter((row) => row.type === "notice");
		after.parent_file_final = entriesOf(ref.id);

		evidence.result = "pass";
		exitCode = 0;
	} catch (error) {
		evidence.result = "fail";
		evidence.error = describeError(error);
		evidence.server_log_tail = logTail(serverLog);
		exitCode = 1;
	} finally {
		if (existsSync(serverLog)) {
			evidence.server_log_fork_lines = readFileSync(serverLog, "utf8")
				.split("\n")
				.filter((line) => line.toLowerCase().includes("fork"))
				.slice(-20);
		}
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
