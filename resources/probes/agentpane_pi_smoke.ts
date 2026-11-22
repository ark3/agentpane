/**
 * One-shot live Pi smoke check through agentpane's production server and its
 * socket (D31).
 *
 * The Codex counterpart proved the transport; this one exists for what is
 * different about Pi, and for the question the Codex run could only answer
 * for Codex.
 *
 * Three things only this harness can establish:
 *
 * - **The spawn chain.** Production builds `direnv exec <workspace> sbox -- pi
 *   --mode rpc` (D7). `capture_fixtures.py` deliberately does *not* go through
 *   sbox -- it spawns Pi directly, because it only needs the protocol -- so
 *   nothing ran Pi through the real wrapper chain until this harness did.
 *   It has since: HANDOFF findings 39-42 (work laptop, pi 0.84.1) and
 *   MANUAL_TESTING's OW-moradi section (home server, pi 0.85.1).
 * - **The rename.** Pi's session id *is* its JSONL path (D9), which Pi chooses
 *   itself, so a `virtual` session's id changes under the client -- at attach
 *   on pi 0.84.1, 0.85.1 and 0.87.1, or on the first prompt for a Pi that names
 *   no path at start. That is the contract most likely to be wrong, and it is
 *   only observable live.
 * - **Signal propagation.** DESIGN's third open question is settled for Codex
 *   and assumed for Pi. Killing the server has to reach an agent two `exec`s
 *   down inside `bwrap`, or every closed session leaks a live agent.
 *
 * ## The model flag
 *
 * `AGENTS.md` pins the home server's Pi to one model and says the flag is the
 * whole of the constraint, because `~/.pi/agent/settings.json` is mutable and
 * was for one day unreadable, when Pi resolved no model at all. So the session
 * is created with an explicit `model`, defaulting to that pin, which reaches
 * `buildPiSpawnCommand`'s `--model` (`src/server/adapters/pi/spawn.ts`). The
 * model that answered is still read back off the wire and recorded beside the
 * flag; the wire string carries a provider prefix the settings file's does not
 * and no thinking-level suffix the flag does.
 *
 * This makes real model calls. It never invokes Codex and never prints
 * credential contents; process inspection is scoped to this run's server tree
 * by `agentpane_live_support.ts`, which owns that guarantee.
 *
 * Usage:  bun resources/probes/agentpane_pi_smoke.ts [--app-root DIR] [--workspace DIR]
 *           [--port N] [--model REF] [--credential-source DIR] [--skip-build] [--tool-check]
 * Prints the evidence as JSON; exits 0 on pass, 1 on fail.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import {
	AgentpaneSocket,
	LONG_PROMPT,
	type ProcessRow,
	REPO,
	type Server,
	type Stamped,
	alive,
	assistantChars,
	buildClient,
	cliVersion,
	compactTree,
	describeError,
	descendants,
	finalize,
	growingAssistantText,
	idleAfterStreaming,
	lastStreaming,
	logTail,
	makeStateHome,
	messageBlockTypes,
	now,
	refsUnder,
	sleep,
	startServer,
	stopServer,
	streamingValue,
	tempLogPath,
	turnMessages,
	waitForBuiltClient,
	waitForTurnToFill,
	type Evidence,
} from "./agentpane_live_support.ts";

const PORT = 44174;
/**
 * Credentials plus the model catalogue and trust state -- the same set
 * `capture_fixtures.py` copies, which is enough for a turn. Copied by name.
 */
export const PI_STATE_FILES = ["auth.json", "models.json", "models-store.json", "settings.json", "trust.json"] as const;
export const PINNED_MODEL = "openrouter/deepseek/deepseek-v4.1-flash:high";

/**
 * The Pi process itself, not the wrappers that carry its argv.
 *
 * The surviving `bwrap` processes have the whole `pi --mode rpc` command line
 * in their own argv, so matching on argv alone counts one agent three times.
 * Match on the program instead.
 *
 * Observed live rather than assumed, and neither guess survived. Pi is a
 * `#!/usr/bin/env node` script, so its process ought to be `node` running a
 * path -- instead it reports `comm=pi` with a command line of exactly `pi`.
 * Setting `process.title` in Node overwrites the argv memory it is stored in,
 * so the flags are gone from the agent's own `/proc/<pid>/cmdline`. The only
 * processes here still carrying `--mode rpc` are the `bwrap` wrappers.
 *
 * So: identify by program, not by argv. The `node` spelling is kept as a
 * fallback in case a future Pi drops the title, because a matcher that
 * silently finds nothing reads exactly like "nothing leaked".
 */
export function piWorkers(rows: ProcessRow[]): ProcessRow[] {
	return rows.filter((row) => row.comm === "pi" || (row.comm === "node" && row.cmd.includes("--mode rpc")));
}

/**
 * The start of the session error the Pi adapter raises for each dialog it
 * cancels at arrival (D2a, `src/server/adapters/pi/process.ts`).
 */
const DIALOG_CANCELLED = "Pi sent a dialog agentpane cannot answer";

/**
 * Dialogs Pi raised and agentpane cancelled between two pinned cuts.
 *
 * agentpane never holds an agent request (D2a): the Pi adapter cancels each
 * dialog the moment it arrives and names it in a session error, so this
 * counts `error` events whose message starts with `DIALOG_CANCELLED`. Events,
 * not snapshots: a snapshot carries only the last turn error, so a second
 * dialog, or any later error, would hide the first.
 *
 * Scoped rather than whole-stream because a whole-stream read has to be taken
 * at some one moment, and the first turn's idle is before the `--tool-check`
 * prompt is even sent, so the tool turn's dialogs would be unreachable
 * (OW-lapuye).
 *
 * A limit, not a defect: the Pi adapter's only source of that error is an
 * `extension_ui_request` carrying a dialog method (`src/server/adapters/pi/reducer.ts`,
 * the `extension_ui_request` arm). An approval arriving by any other mechanism
 * is invisible to this field however it is scoped, so "empty" will never mean
 * "Pi asked nothing" -- only "no dialog reached agentpane".
 */
function dialogsIn(events: Stamped[], start: number, end: number) {
	return {
		window: { from_index: start, to_index: end },
		dialogs: events
			.slice(start, end)
			.filter(([, event]) => event.type === "error" && String(event.message ?? "").startsWith(DIALOG_CANCELLED))
			.map(([at, event]) => ({ at, message: event.message })),
	};
}

function processEvidence(serverPid: number) {
	const tree = descendants(serverPid);
	return { tree: compactTree(tree), workers: piWorkers(tree) };
}

function parseArguments() {
	return parseArgs({
	options: {
		"app-root": { type: "string", default: REPO },
		workspace: { type: "string" },
		port: { type: "string", default: String(PORT) },
		model: { type: "string", default: PINNED_MODEL },
		"credential-source": { type: "string", default: join(homedir(), ".pi", "agent") },
		"skip-build": { type: "boolean", default: false },
		// Also prompt for a shell tool call and assert a toolCall block reaches
		// the wire. Off by default because it is the most model-dependent
		// criterion here -- the model has to choose to call a tool. A Pi dialog
		// does not block the turn, since agentpane cancels it at arrival (D2a,
		// OW-yosuzo), and the error naming it shows up in
		// `agent_dialogs_cancelled` instead.
		"tool-check": { type: "boolean", default: false },
	},
	}).values;
}

async function main(): Promise<number> {
	const args = parseArguments();
	const repo = resolve(args["app-root"]!);
	const workspace = resolve(args.workspace ?? repo);
	const port = Number(args.port);
	const model = args.model!;

	const { home: stateHome, copied } = makeStateHome(resolve(args["credential-source"]!), PI_STATE_FILES, "agentpane-live-pihome-");
	const serverLog = tempLogPath("agentpane-live-server-");
	let server: Server | undefined;
	const sockets: AgentpaneSocket[] = [];
	const launchedWorkers = new Set<number>();
	const checks: Record<string, Record<string, unknown>> = {};
	const evidence: Evidence = {
		started_at: now(),
		backend: "pi",
		workspace,
		pi_version: cliVersion("pi"),
		model_flag: model,
		transport_level: "built client reachability plus the production socket; no browser automation",
		temporary_state_home: stateHome,
		copied_credential_files: copied,
		checks,
	};
	let exitCode = 1;
	try {
		if (!existsSync(join(repo, "package.json"))) throw new Error(`not an agentpane checkout: ${repo}`);
		if (!existsSync(workspace)) throw new Error(`workspace does not exist: ${workspace}`);
		if (!copied.includes("auth.json")) throw new Error(`missing Pi credentials under ${args["credential-source"]}`);

		if (!args["skip-build"]) evidence.build = buildClient(repo);

		server = startServer(repo, { ...process.env, PI_CODING_AGENT_DIR: stateHome, PORT: String(port) }, serverLog);
		evidence.server_pid = server.pid;
		evidence.built_client = { timestamp: now(), ...(await waitForBuiltClient(port, server, 20)) };

		const socket = await AgentpaneSocket.open(port);
		sockets.push(socket);

		// -- 1. spawn through the real wrapper chain ------------------------
		const create = await socket.request("sessions/create", { cwd: workspace, backend: "pi", model }, 120);
		if (!create.ok) throw new Error(`create failed: ${create.code} ${create.detail}`);
		// The create starts the session and answers as an attach does (D30),
		// with the ref it has once started: a `virtual:` one where Pi named no
		// path at start, else Pi's own.
		const createdRef = create.result.session.ref;

		const initial = processEvidence(server.pid);
		for (const row of initial.workers) launchedWorkers.add(row.pid);
		evidence.initial_process_tree = initial.tree;
		evidence.initial_pi_candidates = initial.workers;
		if (initial.workers.length !== 1) {
			// The whole tree, with command lines, because "found 0" is otherwise
			// indistinguishable between "nothing spawned" and "the matcher is wrong".
			evidence.unmatched_process_tree = descendants(server.pid);
			throw new Error(`expected one Pi descendant, found ${initial.workers.length}`);
		}
		const chain = initial.tree.map((row) => row.comm);
		if (!chain.includes("bwrap")) throw new Error(`Pi was not spawned through the sandbox chain: ${chain}`);
		checks.startup = {
			timestamp: now(),
			result: "pass",
			create_reply: "ok",
			still_virtual_after_create: createdRef.id.startsWith("virtual:"),
			process_chain: chain,
			process_tree: initial.tree,
			pi_worker_pids: [...launchedWorkers].sort((a, b) => a - b),
		};

		// -- 2. streaming transcript, prompted by the create's handle ------
		//
		// Every reading and every command from here on is keyed by the handle
		// the create's reply carried, which a rename never changes (D24, D31
		// point 9); a snapshot under that handle carrying the new ref is all a
		// rename is on the wire. So the probe never waits for one: a move is
		// something it records in section 3.
		const handle = create.result.session.handle;
		if (typeof handle !== "string" || !handle) throw new Error(`the create answered no handle: ${JSON.stringify(create.result.session)}`);

		const firstStart = socket.events.length;
		const prompt = await socket.request("sessions/prompt", {
			handle,
			text: "Do not use tools. Reply with two or three sentences about why deterministic tests are useful.",
		});
		if (!prompt.ok) throw new Error(`prompt failed: ${prompt.code} ${prompt.detail}`);
		const growth = await socket.waitFor((events) => growingAssistantText(events, handle, firstStart), 120, "incremental assistant transcript updates");
		const idle = await socket.waitFor((events) => idleAfterStreaming(events, handle, firstStart), 180, "streaming state to return to idle");
		checks.text_stream = { result: "pass", ...growth };
		checks.idle = { result: "pass", ...idle };

		// -- 3. Pi named the session, and the id changed under the client ---
		//
		// D9 once said a `virtual` session has no JSONL path until its first
		// prompt writes one. Observed instead on pi 0.84.1: Pi has named the
		// session file by the time `start()`'s `get_state` probe answers, so the
		// rename lands during the create, which answers the moved ref, and only
		// a rename on the first prompt is seen by the client. Both orderings are
		// legitimate -- the adapter's contract is that `ref` is unstable at two
		// points, not that it changes at exactly one -- so this reads, once the
		// first turn is over, every ref the handle carried and which of the two
		// moved it.
		const refs = refsUnder(socket.snapshot(), handle);
		const realRef = refs.at(-1);
		if (!realRef) throw new Error(`no event arrived under the create reply's handle ${handle}`);
		if (realRef.backend !== "pi") throw new Error(`the handle's events carried no Pi ref: ${JSON.stringify(refs)}`);
		if (realRef.id.startsWith("virtual:") || !realRef.id.endsWith(".jsonl")) {
			throw new Error(`Pi did not adopt a JSONL path as its id: ${JSON.stringify(refs)}`);
		}

		// The create answers the ref the session's container has then (D35 point
		// 1), which is the first the handle carried; an id it outgrows after
		// that reaches nothing, so nothing here attaches by it.
		const first = refs[0]!;
		if (first.backend !== createdRef.backend || first.id !== createdRef.id) {
			throw new Error(`the create answered ${JSON.stringify(createdRef)}, but its handle first carried ${JSON.stringify(first)}`);
		}
		checks.rename = {
			result: "pass",
			handle,
			refs,
			renamed_during: createdRef.id.startsWith("virtual:") ? "first prompt" : "create",
			adopted_id_is_jsonl_path: true,
			created_ref_is_the_first_on_the_handle: true,
		};

		// Which model actually answered. The run passes `--model` (see the
		// module doc), and the criteria that depend on the model most (a tool
		// call happening at all, how much text a long turn produces) cannot be
		// read without it. It shows what ran, not what chose it. `snapshot` and
		// `status` both carry it, but it is null until `start()`'s `get_state`
		// answers, so take the latest one the settled turn left on the wire. The
		// thinking level rides beside it as `effort`.
		const modelSeen = socket
			.snapshot()
			.reverse()
			.find(([, event]) => event.handle === handle && (event.type === "snapshot" || event.type === "status") && typeof event.model === "string" && event.model);
		if (!modelSeen) throw new Error("no settled snapshot or status event named the model Pi resolved");
		checks.model = { result: "pass", flag_passed: model, at: modelSeen[0], model: modelSeen[1].model, effort: modelSeen[1].effort, event_type: modelSeen[1].type };

		// Any dialog Pi raised is worth recording either way: whether these
		// fire at all under the sandbox is an open question, and each one
		// agentpane cancelled is named in a session error (D2a). One entry per
		// turn, so a reader can tell which turn raised what. The window closes
		// at the cut taken here, the first one after the turn reported idle.
		const dialogs: Record<string, unknown> = { first_turn: dialogsIn(socket.snapshot(), firstStart, socket.events.length) };
		evidence.agent_dialogs_cancelled = dialogs;

		if (args["tool-check"]) {
			const toolStart = socket.events.length;
			const tool = await socket.request("sessions/prompt", { handle, text: "Run the shell command `echo agentpane-live-probe` and report its output." });
			if (!tool.ok) throw new Error(`tool prompt failed: ${tool.code} ${tool.detail}`);
			const called = await socket.waitFor(
				(events) => {
					for (const [stamp, event] of events.slice(toolStart)) {
						if (event.handle !== handle) continue;
						const messages = event.type === "upsert" ? [event.message ?? {}] : (event.messages ?? []);
						for (const message of messages) {
							if (messageBlockTypes(message).includes("toolCall")) return { at: stamp, blocks: messageBlockTypes(message) };
						}
					}
					return undefined;
				},
				180,
				"a toolCall block to reach the wire",
			);
			// A `toolCall` on the wire says the turn started, not that it ended,
			// and section 4 sends its prompt the moment this returns: in the
			// OW-moradi `--tool-check` run (`967b319`, 2026-09-13, `pi 0.85.1`),
			// section 4 saw the tool turn's own `streaming=true` 42 ms after the
			// block, so what that run aborted is unknown. Wait for this turn to
			// reach idle, so the abort below is provably sent to a fresh turn.
			const toolIdle = await socket.waitFor((events) => idleAfterStreaming(events, handle, toolStart), 180, "the tool turn to return to idle");
			checks.tool_output = { result: "pass", ...called, turn_streaming_at: toolIdle.streaming_at, turn_idle_at: toolIdle.idle_at, turn_idle_event_type: toolIdle.idle_event_type };
			// The tool turn's own window (HANDOFF finding 42).
			dialogs.tool_turn = dialogsIn(socket.snapshot(), toolStart, socket.events.length);
		}

		// -- 4. abort, then shutdown without an orphan ---------------------
		//
		// The abort is only evidence if the turn it lands on is the one this
		// prompt starts. `streaming_at_abort` below cannot establish that: a
		// previous turn still running answers true exactly as this one does,
		// which is how the OW-moradi `--tool-check` run passed while aborting an
		// unknown turn. So assert the session is idle *before* the prompt is
		// sent -- the reading that does distinguish them -- and record it. The
		// same reading is what lets `turnMessages` take every transcript
		// position past `abortStart` as this turn's.
		const prePromptStreaming = lastStreaming(socket.snapshot(), handle);
		if (prePromptStreaming !== false) {
			throw new Error(
				`a turn was still active when the long prompt was sent, so the aborted turn would not be the long one (last reported state: ${prePromptStreaming})`,
			);
		}

		const abortStart = socket.events.length;
		const long = await socket.request("sessions/prompt", { handle, text: LONG_PROMPT });
		if (!long.ok) throw new Error(`long prompt failed: ${long.code} ${long.detail}`);
		const activeAt = await socket.waitFor(
			(events) => events.slice(abortStart).find(([, event]) => streamingValue(event, handle) === true)?.[0],
			90,
			"long turn streaming=true",
		);

		// Let the turn's own text build up before cutting it, so the abort
		// tears down a large in-flight transcript rather than its first
		// sentence (`waitForTurnToFill`, OW-sofige).
		const abortWait = await waitForTurnToFill(socket, handle, abortStart);

		// The cut is pinned immediately before the request, so a turn that ended
		// on its own cannot stand in for the abort. See the Codex harness for
		// the full argument, including the hole this narrows rather than closes.
		const preAbort = socket.snapshot();
		const abortIndex = preAbort.length;
		const preAbortStreaming = lastStreaming(preAbort, handle);
		const turnAtAbort = turnMessages(preAbort, handle, abortStart);
		if (preAbortStreaming !== true) {
			throw new Error(
				`long turn was not streaming when the abort was sent (last reported state: ${preAbortStreaming}; the turn held ${assistantChars(turnAtAbort)} assistant characters)`,
			);
		}

		const abortRequestedAt = now();
		const abort = await socket.request("sessions/abort", { handle });
		if (!abort.ok) throw new Error(`abort failed: ${abort.code} ${abort.detail}`);
		const aborted = await socket.waitFor(
			(events) => {
				const hit = events.slice(abortIndex).find(([, event]) => streamingValue(event, handle) === false);
				return hit && { timestamp: hit[0], event_type: hit[1].type };
			},
			90,
			"aborted turn streaming=false",
		);
		// The whole of what the turn added, position by position, not a total:
		// a message whose text grows or shrinks after idle, or a message that
		// appears, changes it.
		const turnWhenIdle = turnMessages(socket.snapshot(), handle, abortStart);
		await sleep(1.5);
		const turnAfter = turnMessages(socket.snapshot(), handle, abortStart);
		if (JSON.stringify(turnAfter) !== JSON.stringify(turnWhenIdle)) {
			throw new Error(`the aborted turn changed after it reported idle: ${JSON.stringify(turnWhenIdle)} -> ${JSON.stringify(turnAfter)}`);
		}
		checks.abort = {
			result: "pass",
			prompt_reply: long.result,
			streaming_before_long_prompt: prePromptStreaming,
			streaming_at: activeAt,
			abort_wait: abortWait,
			streaming_at_abort: preAbortStreaming,
			abort_requested_at: abortRequestedAt,
			abort_reply: abort.result,
			idle_at: aborted.timestamp,
			idle_event_type: aborted.event_type,
			assistant_length_at_abort: assistantChars(turnAtAbort),
			assistant_length_when_idle: assistantChars(turnWhenIdle),
			assistant_length_after_settling: assistantChars(turnAfter),
			turn_messages_when_idle: turnWhenIdle,
		};
		// A later move would not have stopped anything above, which is keyed by
		// the handle, so say whether one happened.
		checks.rename.refs_at_end = refsUnder(socket.snapshot(), handle);

		// This is DESIGN's third open question for Pi: the agent is two `exec`s
		// down inside `bwrap`, and nothing else will ever reap it.
		const beforeShutdown = processEvidence(server.pid);
		for (const row of beforeShutdown.workers) launchedWorkers.add(row.pid);
		evidence.shutdown_requested_at = now();
		const returncode = await stopServer(server, 30);
		evidence.server_exit = { timestamp: now(), returncode };
		const deadline = performance.now() + 10_000;
		let remaining = alive(launchedWorkers);
		while (remaining.length && performance.now() < deadline) {
			await sleep(0.1);
			remaining = alive(launchedWorkers);
		}
		checks.shutdown = {
			result: remaining.length ? "fail" : "pass",
			process_tree_before_shutdown: beforeShutdown.tree,
			launched_pi_worker_pids: [...launchedWorkers].sort((a, b) => a - b),
			remaining_worker_pids: remaining,
		};
		if (remaining.length) throw new Error(`run-scoped Pi workers remained after shutdown: ${remaining}`);

		evidence.finished_at = now();
		evidence.result = "pass";
		exitCode = 0;
	} catch (error) {
		evidence.finished_at = now();
		evidence.result = "fail";
		evidence.error = describeError(error);
		evidence.server_log_tail = logTail(serverLog);
		exitCode = 1;
	} finally {
		exitCode = await finalize(evidence, exitCode, { server, sockets, stateHome, serverLog, launchedWorkers, workerFilter: piWorkers });
	}
	console.log(JSON.stringify(evidence, null, 2));
	return exitCode;
}

if (import.meta.main) process.exit(await main());
