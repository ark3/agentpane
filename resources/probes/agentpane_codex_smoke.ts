/**
 * One-shot live Codex smoke check through agentpane's production server and
 * its socket (D31).
 *
 * This makes real model calls. It never invokes Pi and never prints credential
 * contents. Process inspection is scoped to the server tree this run launched;
 * `agentpane_live_support.ts` owns that guarantee for every probe using it.
 *
 * The session is created with an explicit `model`, defaulting to the one
 * `AGENTS.md` pins, because nothing else would choose it: agentpane spawns a
 * bare `codex app-server` (`codexCommand`) and sends no model on
 * `thread/start` unless the session was created with one, so Codex would
 * answer on whatever the `config.toml` copied into the throwaway `CODEX_HOME`
 * names. The model the thread reported is read back off the wire and recorded
 * beside the flag (OW-yehisa).
 *
 * Every wait and every command is keyed by the handle the create's reply
 * carried (D31 point 9), as the Pi harness is.
 *
 * Usage:  bun resources/probes/agentpane_codex_smoke.ts [--app-root DIR] [--workspace DIR]
 *           [--port N] [--model ID] [--credential-source DIR] [--skip-build]
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
	assistantText,
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
	maxAssistantLength,
	now,
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

const PORT = 44173;
/** Credentials plus the config Codex needs to reach a model. Copied by name. */
export const CODEX_STATE_FILES = ["auth.json", "config.toml"] as const;
export const PINNED_MODEL = "gpt-5.6-luna";

/**
 * The npm launcher is a Node process whose argv also says `app-server`; it
 * starts one native binary named `codex`. Count that leaf worker while
 * retaining the complete launcher tree separately as evidence.
 */
export function codexWorkers(rows: ProcessRow[]): ProcessRow[] {
	return rows.filter((row) => row.comm === "codex" && row.cmd.includes("app-server"));
}

function processEvidence(serverPid: number) {
	const tree = descendants(serverPid);
	return { tree: compactTree(tree), workers: codexWorkers(tree) };
}

function parseArguments() {
	return parseArgs({
		options: {
			"app-root": { type: "string", default: REPO },
			workspace: { type: "string" },
			port: { type: "string", default: String(PORT) },
			model: { type: "string", default: PINNED_MODEL },
			"credential-source": { type: "string", default: join(homedir(), ".codex") },
			"skip-build": { type: "boolean", default: false },
		},
	}).values;
}

async function main(): Promise<number> {
	const args = parseArguments();
	const repo = resolve(args["app-root"]!);
	const workspace = resolve(args.workspace ?? repo);
	const port = Number(args.port);
	const model = args.model!;

	const { home: stateHome, copied } = makeStateHome(resolve(args["credential-source"]!), CODEX_STATE_FILES, "agentpane-live-codexhome-");
	const serverLog = tempLogPath("agentpane-live-server-");
	let server: Server | undefined;
	const sockets: AgentpaneSocket[] = [];
	const launchedWorkers = new Set<number>();
	const checks: Record<string, Record<string, unknown>> = {};
	const evidence: Evidence = {
		started_at: now(),
		backend: "codex",
		workspace,
		codex_version: cliVersion("codex"),
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
		if (!copied.includes("auth.json")) throw new Error(`missing Codex credentials under ${args["credential-source"]}`);

		if (!args["skip-build"]) evidence.build = buildClient(repo);

		server = startServer(repo, { ...process.env, CODEX_HOME: stateHome, PORT: String(port) }, serverLog);
		evidence.server_pid = server.pid;
		evidence.built_client = { timestamp: now(), ...(await waitForBuiltClient(port, server, 20)) };

		const socket = await AgentpaneSocket.open(port);
		sockets.push(socket);

		const create = await socket.request("sessions/create", { cwd: workspace, backend: "codex", model }, 120);
		if (!create.ok) throw new Error(`create failed: ${create.code} ${create.detail}`);
		// The create starts the session and answers as an attach does (D30).
		const realRef = create.result.session.ref;
		if (realRef.backend !== "codex" || realRef.id.startsWith("virtual:")) {
			throw new Error(`the create did not adopt a Codex thread id: ${JSON.stringify(realRef)}`);
		}
		const handle = create.result.session.handle;
		if (typeof handle !== "string" || !handle) throw new Error(`the create answered no handle: ${JSON.stringify(create.result.session)}`);

		const initial = processEvidence(server.pid);
		evidence.initial_process_tree = initial.tree;
		evidence.initial_app_server_candidates = initial.workers;
		for (const row of initial.workers) launchedWorkers.add(row.pid);
		if (initial.workers.length !== 1) throw new Error(`expected one Codex app-server descendant, found ${initial.workers.length}`);
		checks.create = {
			timestamp: now(),
			result: "pass",
			create_reply: "ok",
			handle,
			ref: realRef,
			virtual_id_adopted: true,
			process_tree: initial.tree,
			codex_worker_pids: [...launchedWorkers].sort((a, b) => a - b),
		};

		const firstStart = socket.events.length;
		const prompt = await socket.request("sessions/prompt", {
			handle,
			text: "Do not use tools. Write one sentence of at least 120 words explaining why deterministic tests are useful.",
		});
		if (!prompt.ok) throw new Error(`prompt failed: ${prompt.code} ${prompt.detail}`);
		if (prompt.result.disposition !== "started") throw new Error(`prompt started no turn: ${JSON.stringify(prompt.result)}`);

		const growth = await socket.waitFor((events) => growingAssistantText(events, handle, firstStart), 90, "incremental assistant transcript updates");
		const idle = await socket.waitFor((events) => idleAfterStreaming(events, handle, firstStart), 180, "streaming state to return to idle");
		checks.text_stream = { timestamp: now(), result: "pass", prompt_reply: prompt.result, ...growth };
		checks.idle = { result: "pass", ...idle };

		// Which model the thread reported, off the latest `snapshot` or `status`
		// the settled turn left on the wire: the adapter fills it from the
		// `thread/start` answer (`CodexAdapter.start`), so it is Codex's word,
		// not an echo of the flag.
		const modelSeen = socket
			.snapshot()
			.reverse()
			.find(([, event]) => event.handle === handle && (event.type === "snapshot" || event.type === "status") && typeof event.model === "string" && event.model);
		if (!modelSeen) throw new Error("no settled snapshot or status event named the model Codex resolved");
		checks.model = { result: "pass", flag_passed: model, at: modelSeen[0], model: modelSeen[1].model, event_type: modelSeen[1].type };

		// A second socket's opening snapshots have to repaint the finished turn,
		// and the session has to outlive the first socket without a new worker.
		const finalLength = maxAssistantLength(socket.snapshot(), handle);
		const beforeReconnect = processEvidence(server.pid);
		await socket.close();

		const reconnect = await AgentpaneSocket.open(port);
		sockets.push(reconnect);
		const repaint = await reconnect.waitFor(
			(events: Stamped[]) => {
				for (const [stamp, event] of events) {
					if (event.type !== "snapshot" || event.handle !== handle) continue;
					const lengths = (event.messages ?? []).map(assistantText).filter(Boolean).map((text: string) => text.length);
					if (lengths.length && Math.max(...lengths) >= finalLength) {
						return { snapshot_at: stamp, message_count: event.messages.length, assistant_text_length: Math.max(...lengths) };
					}
				}
				return undefined;
			},
			20,
			"reconnect snapshot repaint",
		);
		const afterReconnect = processEvidence(server.pid);
		for (const row of afterReconnect.workers) launchedWorkers.add(row.pid);
		const beforePids = beforeReconnect.workers.map((row) => row.pid).sort((a, b) => a - b);
		const afterPids = afterReconnect.workers.map((row) => row.pid).sort((a, b) => a - b);
		if (JSON.stringify(beforePids) !== JSON.stringify(afterPids) || afterPids.length !== 1) {
			throw new Error(`Codex worker changed across reconnect: before=${beforePids}, after=${afterPids}`);
		}
		checks.reconnect = {
			result: "pass",
			...repaint,
			codex_worker_pids_before: beforePids,
			codex_worker_pids_after: afterPids,
			process_tree_before: beforeReconnect.tree,
			process_tree_after: afterReconnect.tree,
		};

		// The aborted turn's messages are read as every position past the
		// transcript's length at this cut (`turnMessages`), which holds only if
		// no earlier turn is still writing: the first turn reported idle above
		// and nothing has been prompted since.
		const abortStart = reconnect.events.length;
		const long = await reconnect.request("sessions/prompt", { handle, text: LONG_PROMPT });
		if (!long.ok) throw new Error(`long prompt failed: ${long.code} ${long.detail}`);
		if (long.result.disposition !== "started") throw new Error(`long prompt started no turn: ${JSON.stringify(long.result)}`);
		const activeAt = await reconnect.waitFor(
			(events) => events.slice(abortStart).find(([, event]) => streamingValue(event, handle) === true)?.[0],
			60,
			"long turn streaming=true",
		);

		// Let the turn's own text build up before cutting it, so the abort
		// tears down a large in-flight transcript rather than its first
		// sentence (`waitForTurnToFill`, OW-sofige).
		const abortWait = await waitForTurnToFill(reconnect, handle, abortStart);

		// Everything the abort is judged on has to arrive after this point.
		// Scanning from the prompt instead lets a turn that ended on its own --
		// or an idle event left over from the reconnect -- stand in for the
		// abort, and that is a pass the check cannot tell from a real one. So:
		// pin the cut, require the turn to be streaming right up to it, and
		// accept only an idle that arrives past it.
		//
		// The cut is taken immediately before the request, not after it, so a
		// turn that ends of its own accord during the abort's round trip still
		// satisfies this. That hole is narrow rather than closed; closing it
		// needs a causal signal from the backend, which the socket's events do
		// not carry.
		const preAbort = reconnect.snapshot();
		const abortIndex = preAbort.length;
		const preAbortStreaming = lastStreaming(preAbort, handle);
		const turnAtAbort = turnMessages(preAbort, handle, abortStart);
		if (preAbortStreaming !== true) {
			throw new Error(
				`long turn was not streaming when the abort was issued (last reported state: ${preAbortStreaming}; the turn held ${assistantChars(turnAtAbort)} assistant characters)`,
			);
		}

		const abortRequestedAt = now();
		const abort = await reconnect.request("sessions/abort", { handle });
		if (!abort.ok) throw new Error(`abort failed: ${abort.code} ${abort.detail}`);
		const aborted = await reconnect.waitFor(
			(events) => {
				const hit = events.slice(abortIndex).find(([, event]) => streamingValue(event, handle) === false);
				return hit && { timestamp: hit[0], event_type: hit[1].type };
			},
			60,
			"aborted turn streaming=false",
		);

		// Idle is a claim about the turn; the transcript is what proves it. A
		// turn that keeps emitting text after reporting idle was not aborted.
		// Compared position by position, not as a total: a message whose text
		// grows or shrinks after idle, or a message that appears, changes it.
		const turnWhenIdle = turnMessages(reconnect.snapshot(), handle, abortStart);
		await sleep(1.5);
		const turnAfter = turnMessages(reconnect.snapshot(), handle, abortStart);
		if (JSON.stringify(turnAfter) !== JSON.stringify(turnWhenIdle)) {
			throw new Error(`the aborted turn changed after it reported idle: ${JSON.stringify(turnWhenIdle)} -> ${JSON.stringify(turnAfter)}`);
		}
		checks.abort = {
			result: "pass",
			prompt_reply: long.result,
			streaming_at: activeAt,
			abort_wait: abortWait,
			streaming_at_abort: preAbortStreaming,
			events_before_abort: abortIndex,
			abort_requested_at: abortRequestedAt,
			abort_reply: abort.result,
			idle_at: aborted.timestamp,
			idle_event_type: aborted.event_type,
			assistant_length_at_abort: assistantChars(turnAtAbort),
			assistant_length_when_idle: assistantChars(turnWhenIdle),
			assistant_length_after_settling: assistantChars(turnAfter),
			turn_messages_when_idle: turnWhenIdle,
		};

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
			launched_codex_worker_pids: [...launchedWorkers].sort((a, b) => a - b),
			remaining_worker_pids: remaining,
		};
		if (remaining.length) throw new Error(`run-scoped Codex workers remained after shutdown: ${remaining}`);

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
		exitCode = await finalize(evidence, exitCode, { server, sockets, stateHome, serverLog, launchedWorkers, workerFilter: codexWorkers });
	}
	console.log(JSON.stringify(evidence, null, 2));
	return exitCode;
}

if (import.meta.main) process.exit(await main());
