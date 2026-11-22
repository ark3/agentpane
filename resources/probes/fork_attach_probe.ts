/**
 * Fork the most recent turn with fork-and-prompt, then attach the fork again,
 * through the production server and its socket (D31).
 *
 * The client's `forkAndSubmit` was a four-request round trip -- fork points,
 * fork, attach, prompt -- until ark3/agentpane#51 made it one fork-and-prompt
 * (D30), and the three backends reach "attached to the fork" by three
 * different routes: Pi's fork moves the live process onto a new file, Codex
 * flushes the forked rollout to disk before `thread/fork` returns (as of
 * `codex-cli 0.154.0`, OW-lajehi), and Claude Code's fork runs nothing at all
 * until the attach spawns it (OW-razoki, OW-japuzo). Nothing had ever run that
 * sequence against a real backend through the real server; `fork_probe.py`
 * drives the CLIs directly and never sees agentpane's session manager, and the
 * browser vehicle in `e2e/` has no server.
 *
 * This probe is the missing middle. It reports rather than asserts: a refused
 * fork or attach is the measurement, not a crash, so every step records its
 * reply's result or refusal code and the run continues to the next one.
 *
 * What it drives, per backend:
 *
 *   1. `sessions/forkPoints`, then one `sessions/forkAndPrompt` at the LAST
 *      fork point -- the "edit last message" case, after two real turns, so
 *      "the most recent turn" is not also the first
 *   2. wait out the fork's turn under the handle the reply named, and read
 *      its reply back off the wire
 *   3. re-attach that fork once its store file exists
 *   4. fork the fork at ITS most recent turn, the same way
 *   5. on Codex only: close one side of the fork pair and attach it again
 *      while the other side is still live (OW-voyezi)
 *   6. fork the parent a second time at the same point it was forked at
 *
 * Step 5 is Codex's alone because the lock is Codex's alone. A Codex fork
 * shares its parent's `codex app-server` (OW-lajehi) and a thread stays
 * locked to the process that opened it even after the adapter holding it is
 * disposed, so this is the sequence that used to be refused `internal_error`,
 * `already has an active writer`. Pi and Claude Code spawn a child per
 * session and have nothing to re-borrow.
 *
 * Every backend runs against its REAL state directory, and this run therefore
 * leaves four small sessions in each store it touches. That is not laziness
 * and it cannot be avoided by relocating the CLI: agentpane derives the
 * session roots from `homedir()` and reads no `CODEX_HOME`,
 * `PI_CODING_AGENT_DIR` or `CLAUDE_CONFIG_DIR` (`src/server/sessions/index.ts`,
 * `claude/adapter.ts`), so a run that moves the CLI's store moves it out from
 * under the server's own index -- and the attach this probe measures is
 * exactly the request that consults that index. Measured on 2026-09-15: with
 * `CODEX_HOME` relocated, every Codex fork attach 404s on a rollout that is
 * demonstrably on disk, and a relocated `CLAUDE_CONFIG_DIR` yields no fork
 * points at all. Both are the harness lying, not the product failing, which is
 * the whole reason this note is longer than the code it explains.
 *
 * Each backend is pinned to its model explicitly rather than inheriting
 * whatever the settings file happens to say (AGENTS.md; OW-yehisa was that
 * defect in the two smoke harnesses).
 *
 * Every backend's server listens on the same port, one after another: each is
 * stopped before the next starts, and the ports past this one are other
 * probes' defaults.
 *
 * Usage:  bun resources/probes/fork_attach_probe.ts [--backend pi|codex|claude]...
 *           [--workspace DIR] [--port N] [--turn-timeout SECONDS] [--skip-build] [--out FILE]
 * Prints the report as JSON; exits 0 when every backend passed, 1 otherwise.
 */

import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
	AgentpaneSocket,
	type ProcessRow,
	REPO,
	type Server,
	TimeoutError,
	assistantText,
	buildClient,
	cliVersion,
	describeError,
	finalize,
	idleAfterStreaming,
	logTail,
	now,
	refsUnder,
	sleep,
	startServer,
	tempLogPath,
	transcript,
	waitForBuiltClient,
	type Evidence,
} from "./agentpane_live_support.ts";
import type { BackendId, SessionRef } from "../../src/shared/protocol.ts";

const PORT = 44177;

type Step = Record<string, unknown>;

/**
 * Per backend: the store the server itself reads, the model the pin names,
 * and how its worker shows up in the server's process tree. `storeRoot` is
 * used only to watch a fork appear on disk; nothing here ever writes to it or
 * removes it.
 */
const BACKENDS: Record<BackendId, { storeRoot: string; model: string; comms: string[] }> = {
	pi: { storeRoot: "~/.pi/agent/sessions", model: "openrouter/deepseek/deepseek-v4.1-flash:high", comms: ["pi"] },
	codex: { storeRoot: "~/.codex/sessions", model: "gpt-5.6-luna", comms: ["codex", "codex-app-server"] },
	claude: { storeRoot: "~/.claude/projects", model: "haiku", comms: ["claude", "node"] },
};

function expandHome(path: string): string {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function workerFilterFor(backend: BackendId): (rows: ProcessRow[]) => ProcessRow[] {
	const comms = BACKENDS[backend].comms;
	return (rows) => rows.filter((row) => comms.includes(row.comm));
}

/**
 * Wait for the turn begun at the cut `start` to go up and come back down
 * under `handle`, and report it.
 *
 * Waits by the handle a reply carried, never by a ref: every backend replaces
 * a `virtual:` ref at attach and some move it again later (D9), and since
 * OW-mofuho a move is only a snapshot under the unchanged handle carrying the
 * new ref (D24). What the session is called when the turn settles is
 * reported as `ref`, and every name it has carried as `refs`.
 */
async function settle(socket: AgentpaneSocket, handle: string, start: number, label: string, timeout: number): Promise<Step> {
	let idle;
	try {
		idle = await socket.waitFor((events) => idleAfterStreaming(events, handle, start), timeout, label);
	} catch (error) {
		if (error instanceof TimeoutError) return { result: "timeout", error: error.message };
		throw error;
	}
	const events = socket.snapshot();
	const replies = events
		.slice(start)
		.filter(([, event]) => event.type === "upsert" && event.handle === handle)
		.map(([, event]) => assistantText(event.message))
		.filter((text) => text);
	const refs = refsUnder(events, handle);
	return { result: "pass", streaming_at: idle.streaming_at, idle_at: idle.idle_at, ref: refs.at(-1), refs, reply_tail: (replies.at(-1) ?? "").slice(-200) };
}

/** Prompt the live session under `handle` and wait its turn out. */
async function turn(socket: AgentpaneSocket, handle: string, text: string, timeout: number): Promise<Step> {
	const start = socket.events.length;
	const reply = await socket.request("sessions/prompt", { handle, text });
	const record: Step = { prompted_at: now(), prompt_reply: reply.ok ? "ok" : reply.code };
	if (!reply.ok) return { ...record, prompt_detail: reply.detail };
	return { ...record, disposition: reply.result.disposition, ...(await settle(socket, handle, start, `the turn prompted with ${JSON.stringify(text)} to finish`, timeout)) };
}

/** This session's transcript as the wire has described it, summarised by role. */
function transcriptOf(socket: AgentpaneSocket, handle: string): Step {
	const messages = transcript(socket.snapshot(), handle);
	return {
		count: messages.length,
		roles: messages.map((message) => message.role),
		user_texts: messages
			.filter((message) => message.role === "user")
			.map((message) =>
				(message.content ?? [])
					.filter((block: Record<string, unknown>) => block && typeof block === "object" && block.type === "text")
					.map((block: Record<string, unknown>) => block.text ?? "")
					.join("")
					.slice(0, 60),
			),
	};
}

function onDisk(storeRoot: string, backend: BackendId, id: string): boolean {
	if (backend === "pi") return existsSync(id);
	const pattern = backend === "claude" ? `*/${id}.jsonl` : "**/*.jsonl";
	for (const path of new Bun.Glob(pattern).scanSync({ cwd: storeRoot, onlyFiles: true })) {
		if (backend === "claude" || path.includes(id)) return true;
	}
	return false;
}

/**
 * How long the fork took to show up in the backend's store after the
 * fork-and-prompt answered, if it did within `window` seconds.
 *
 * The manager resolves an attach it has no table entry for through the
 * session index, which is a walk of that store (`SessionManager.#start`), so
 * "on disk" and "attachable later" are the same question. Polled rather than
 * sampled once: a fork written a beat after the reply and a fork never
 * written at all differ only on the clock. The reply now follows the fork's
 * attach and its prompt, so on Claude Code, whose fork wrote nothing until
 * its attach spawned it (OW-razoki), this is measured too.
 */
async function findOnDisk(storeRoot: string, backend: BackendId, ref: SessionRef, window: number): Promise<number | null> {
	const started = performance.now();
	const deadline = started + window * 1000;
	while (true) {
		if (onDisk(storeRoot, backend, ref.id)) return Math.round(performance.now() - started) / 1000;
		if (performance.now() >= deadline) return null;
		await sleep(0.1);
	}
}

/**
 * Fork points, the last of them, and one fork-and-prompt there (D30), then
 * the fork's turn: `forkAndSubmit`'s whole edit, answered under the fork's
 * own handle.
 *
 * A refusal after the fork exists names it (`ReplyFailed.fork`); the step
 * then attaches it once more, well after the fork, so "the store had not
 * caught up" and "nothing was ever written" are distinguishable in the
 * record.
 */
async function forkAtLastPoint(
	socket: AgentpaneSocket,
	parent: { ref: SessionRef; handle: string },
	text: string,
	options: { backend: BackendId; storeRoot: string; timeout: number },
): Promise<Step> {
	const { backend, storeRoot, timeout } = options;
	const step: Step = { at: now(), parent: parent.ref, parent_handle: parent.handle };
	const points = await socket.request("sessions/forkPoints", { handle: parent.handle });
	step.fork_points_reply = points.ok ? "ok" : points.code;
	if (!points.ok || !points.result.points.length) {
		if (!points.ok) step.fork_points_detail = points.detail;
		step.result = "no fork points";
		return step;
	}
	const listed = points.result.points;
	step.fork_points = listed.map((point) => ({ index: point.index, text: point.text.slice(0, 60) }));
	const last = listed.at(-1)!;
	step.forked_at = { index: last.index, text: last.text.slice(0, 60) };

	const start = socket.events.length;
	const forked = await socket.request("sessions/forkAndPrompt", { handle: parent.handle, index: last.index, text }, 180);
	step.fork_and_prompt_reply = forked.ok ? "ok" : forked.code;
	if (!forked.ok) {
		step.fork_and_prompt_detail = forked.detail;
		step.fork = forked.fork;
		step.result = "fork and prompt refused";
		const fork = forked.fork as { ref: SessionRef; handle: string | null } | undefined;
		if (fork?.ref) {
			step.fork_ref = fork.ref;
			step.on_disk_after_seconds = await findOnDisk(storeRoot, backend, fork.ref, 5);
			await sleep(5);
			step.on_disk_after_retry_seconds = await findOnDisk(storeRoot, backend, fork.ref, 0.1);
			const retry = await socket.request("sessions/attach", { ref: fork.ref }, 120);
			step.retry_attach_reply = retry.ok ? "ok" : retry.code;
			step.retry_attach_detail = retry.ok ? { ref: retry.result.session.ref, handle: retry.result.session.handle } : retry.detail;
		}
		return step;
	}
	const fork = forked.result.session;
	step.fork_ref = fork.ref;
	step.fork_handle = fork.handle;
	step.disposition = forked.result.disposition;
	step.on_disk_after_seconds = await findOnDisk(storeRoot, backend, fork.ref, 5);
	const forkTurn = await settle(socket, fork.handle, start, `the fork's turn prompted with ${JSON.stringify(text)} to finish`, timeout);
	step.fork_turn = forkTurn;
	step.result = forkTurn.result === "pass" ? "pass" : "fork turn did not settle";
	if (forkTurn.result === "pass") {
		step.attached_ref = forkTurn.ref ?? fork.ref;
		step.attached_handle = fork.handle;
		step.fork_transcript = transcriptOf(socket, fork.handle);
	}
	return step;
}

/**
 * Close one side of a fork pair and attach it again while `holder` still
 * lives.
 *
 * The window OW-lajehi opened and OW-voyezi closed. A close releases this
 * session's share of the shared `codex app-server` but cannot kill it, and as
 * of `codex-cli 0.154.0` nothing else releases the thread's writer lock --
 * `thread/unsubscribe` answers `unsubscribed` and leaves it exactly where it
 * was (`codex_unsubscribe_probe.py`). So the attach has to come back to that
 * same child; a fresh app-server would be refused.
 */
async function closeAndReattach(socket: AgentpaneSocket, { ref, handle }: { ref: SessionRef; handle: string }, holder: SessionRef): Promise<{ step: Step; handle?: string }> {
	const step: Step = { at: now(), closed: ref, closed_handle: handle, still_open: holder };
	// By its handle, as every client closes (D35 point 3).
	const close = await socket.request("sessions/close", { handle });
	step.close_reply = close.ok ? "ok" : close.code;
	// The close is answered before the adapter has finished letting go;
	// nothing observable marks that, so this waits rather than races it.
	await sleep(2);
	const attach = await socket.request("sessions/attach", { ref }, 120);
	step.attach_reply = attach.ok ? "ok" : attach.code;
	step.attach_detail = attach.ok ? { ref: attach.result.session.ref, handle: attach.result.session.handle } : attach.detail;
	step.result = attach.ok ? "pass" : "reattach failed";
	return { step, handle: attach.ok ? attach.result.session.handle : undefined };
}

async function runBackend(backend: BackendId, workspace: string, port: number, turnTimeout: number): Promise<Evidence> {
	const spec = BACKENDS[backend];
	const storeRoot = expandHome(spec.storeRoot);
	// `finalize` removes what it is handed, so it is handed a scratch directory
	// this run owns and nothing else. The backend stores above are the owner's
	// and are only ever read.
	const scratch = mkdtempSync(`/var/tmp/agentpane-forkattach-${backend}-`);
	const serverLog = tempLogPath(`agentpane-forkattach-${backend}-`);
	let server: Server | undefined;
	const sockets: AgentpaneSocket[] = [];
	const launched = new Set<number>();
	const steps: Record<string, unknown> = {};
	const evidence: Evidence = {
		backend,
		started_at: now(),
		workspace,
		model_pin: spec.model,
		version: cliVersion(backend),
		store_root: storeRoot,
		port,
		steps,
	};
	let exitCode = 1;
	try {
		if (!existsSync(storeRoot) || !statSync(storeRoot).isDirectory()) throw new Error(`${backend} has no store at ${storeRoot}`);

		server = startServer(REPO, { ...process.env, PORT: String(port) }, serverLog);
		evidence.server_pid = server.pid;
		await waitForBuiltClient(port, server, 30);

		const socket = await AgentpaneSocket.open(port);
		sockets.push(socket);
		const fork = { backend, storeRoot, timeout: turnTimeout };

		const create = await socket.request("sessions/create", { cwd: workspace, backend, model: spec.model }, 120);
		if (!create.ok) throw new Error(`create failed: ${create.code} ${create.detail}`);
		// The create starts the session and answers as an attach does (D30).
		let ref: SessionRef = create.result.session.ref;
		let handle = create.result.session.handle;
		steps.session = { create_reply: "ok", ref, handle };

		// Two turns, so the last fork point is not also the first.
		const first = await turn(socket, handle, "Reply with exactly the word ONE and nothing else.", turnTimeout);
		steps.turn_one = first;
		if (first.result !== "pass") throw new Error(`the first turn never settled: ${JSON.stringify(first)}`);
		const second = await turn(socket, handle, "Reply with exactly the word TWO and nothing else.", turnTimeout);
		steps.turn_two = second;
		if (second.result !== "pass") throw new Error(`the second turn never settled: ${JSON.stringify(second)}`);
		ref = (second.ref as SessionRef | undefined) ?? ref;
		steps.parent_transcript = transcriptOf(socket, handle);

		// 1 and 2. The case the owner reports: edit the last message.
		const forked = await forkAtLastPoint(socket, { ref, handle }, "Reply with exactly the word THREE and nothing else.", fork);
		steps.fork_last_turn = forked;

		if (forked.result !== "pass" && forked.fork_ref) {
			// Whose lock is it? Codex 0.154.0 refused a second writer on a
			// thread ("already has an active writer"), and the only other
			// candidate holder is the parent's own app-server process -- which
			// this closes, so a fork that attaches afterwards names it.
			const close = await socket.request("sessions/close", { handle });
			await sleep(2);
			const retry = await socket.request("sessions/attach", { ref: forked.fork_ref as SessionRef }, 120);
			steps.attach_fork_after_closing_parent = {
				close_reply: close.ok ? "ok" : close.code,
				attach_reply: retry.ok ? "ok" : retry.code,
				attach_detail: retry.ok ? { ref: retry.result.session.ref } : retry.detail,
				result: retry.ok ? "pass" : "attach failed",
			};
		}

		if (forked.result === "pass") {
			let forkRef = forked.attached_ref as SessionRef;
			let forkHandle = forked.attached_handle as string;

			// 3. Re-attach, now that the fork's own store file exists.
			const again = await socket.request("sessions/attach", { ref: forkRef }, 120);
			steps.reattach_fork = {
				reply: again.ok ? "ok" : again.code,
				detail: again.ok ? { ref: again.result.session.ref, handle: again.result.session.handle, same_handle: again.result.session.handle === forkHandle } : again.detail,
			};
			if (again.ok) forkHandle = again.result.session.handle;

			// 4. Fork the fork at ITS most recent turn.
			steps.fork_of_fork = await forkAtLastPoint(socket, { ref: forkRef, handle: forkHandle }, "Reply with exactly the word FOUR and nothing else.", fork);

			// 5. Close one side of the pair and re-attach it while the other
			//    still holds the shared child (OW-voyezi).
			if (backend === "codex") {
				const parentSide = await closeAndReattach(socket, { ref, handle }, forkRef);
				steps.reattach_parent_after_closing_it = parentSide.step;
				if (parentSide.handle) handle = parentSide.handle;
				steps.reattach_fork_after_closing_it = (await closeAndReattach(socket, { ref: forkRef, handle: forkHandle }, ref)).step;
			}
		}

		// 6. And the parent a second time at the same point it was forked at.
		// An attach of a live session answers its handle, and of a closed one
		// starts it under a new one.
		const parent = await socket.request("sessions/attach", { ref }, 120);
		steps.parent_still_attaches = { reply: parent.ok ? "ok" : parent.code, ...(parent.ok ? { handle: parent.result.session.handle } : { detail: parent.detail }) };
		if (parent.ok) handle = parent.result.session.handle;
		const secondFork = await forkAtLastPoint(socket, { ref, handle }, "Reply with exactly the word FIVE and nothing else.", fork);
		secondFork.same_point_as_first = (secondFork.forked_at as Step | undefined)?.index === (forked.forked_at as Step | undefined)?.index;
		steps.second_fork_of_parent = secondFork;

		const failures = Object.entries(steps)
			.filter(([, step]) => typeof step === "object" && step !== null && (step as Step).result !== undefined && (step as Step).result !== "pass")
			.map(([name]) => name);
		evidence.result = failures.length ? "fail" : "pass";
		evidence.failed_steps = failures;
		exitCode = failures.length ? 1 : 0;
	} catch (error) {
		evidence.result = "error";
		evidence.error = describeError(error);
	} finally {
		// Before `finalize` deletes it: the backend's own complaint is here and
		// nowhere else, and it is the whole reason to run this.
		evidence.server_log_tail = logTail(serverLog);
		exitCode = await finalize(evidence, exitCode, {
			server,
			sockets,
			stateHome: scratch,
			serverLog,
			launchedWorkers: launched,
			workerFilter: workerFilterFor(backend),
		});
	}
	evidence.finished_at = now();
	evidence.exit_code = exitCode;
	return evidence;
}

function parseArguments() {
	return parseArgs({
		options: {
			// Repeatable; default all three.
			backend: { type: "string", multiple: true },
			workspace: { type: "string", default: REPO },
			port: { type: "string", default: String(PORT) },
			"turn-timeout": { type: "string", default: "300" },
			"skip-build": { type: "boolean", default: false },
			// Write the JSON report here as well as to stdout.
			out: { type: "string" },
		},
	}).values;
}

async function main(): Promise<number> {
	const args = parseArguments();
	const workspace = resolve(expandHome(args.workspace!));
	if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
		console.error(`workspace does not exist: ${workspace}`);
		return 2;
	}
	const backends = (args.backend ?? Object.keys(BACKENDS)) as BackendId[];
	for (const backend of backends) {
		if (!(backend in BACKENDS)) {
			console.error(`unknown backend: ${backend}; one of ${Object.keys(BACKENDS).join(", ")}`);
			return 2;
		}
	}

	const runs: Record<string, Evidence> = {};
	const report: Record<string, unknown> = { started_at: now(), workspace, runs };
	if (!args["skip-build"]) report.build = buildClient(REPO);
	for (const backend of backends) {
		runs[backend] = await runBackend(backend, workspace, Number(args.port), Number(args["turn-timeout"]));
		await sleep(1);
	}
	report.finished_at = now();
	report.result = Object.values(runs).every((run) => run.result === "pass") ? "pass" : "fail";
	const text = JSON.stringify(report, null, 2);
	console.log(text);
	if (args.out) writeFileSync(args.out, `${text}\n`);
	return report.result === "pass" ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
