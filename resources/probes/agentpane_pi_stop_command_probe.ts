/**
 * A Stop pressed behind a Pi extension command that awaits idle, through the
 * production server and its socket (ark3/agentpane#93, D16).
 *
 * `PiAdapter.abort` waits on the prompts already written to Pi for up to
 * `stopWaitMs` before it sends `clear_queue` and `abort`. As of `pi 1.5.2` Pi
 * answers a prompt naming an extension command only once its handler returns,
 * so one awaiting `ctx.waitForIdle()` is answered at the turn's end
 * (`pi_stop_compact_probe.ts`). This sends a long prompt, and once its text
 * streams, a prompt naming such a command; 1 s later it sends a Stop, and
 * records how long the turn took to report idle against the deadline.
 *
 * The command is the one `pi_stop_compact_probe.ts` loads. agentpane's spawn
 * passes no `-e`, so it goes in the `extensions/` directory of a throwaway
 * `PI_CODING_AGENT_DIR` holding copies of the machine's state files, passed in
 * the server's environment as `agentpane_pi_smoke.ts` passes it.
 *
 * It exits 0 when the turn was streaming at the Stop and idle within
 * `stopWaitMs` and the `--slack` after it, 1 otherwise.
 *
 * Usage:  bun resources/probes/agentpane_pi_stop_command_probe.ts [--workspace DIR]
 *           [--port N] [--model REF] [--slack SECONDS] [--skip-build] [--out FILE]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
	AgentpaneSocket,
	LONG_PROMPT,
	REPO,
	type Server,
	buildClient,
	cliVersion,
	descendants,
	describeError,
	finalize,
	growingAssistantText,
	lastStreaming,
	logTail,
	makeStateHome,
	now,
	sleep,
	startServer,
	streamingValue,
	tempLogPath,
	waitForBuiltClient,
	type Evidence,
} from "./agentpane_live_support.ts";
import { PI_STATE_FILES, PINNED_MODEL, piWorkers } from "./agentpane_pi_smoke.ts";
import { stopWaitMs } from "../../src/server/adapters/pi/process.ts";

const PORT = 44183;
const COMMAND = "probe-wait-idle";
const EXTENSION = `export default function (pi) {
	pi.registerCommand(${JSON.stringify(COMMAND)}, {
		description: "Wait for the agent to go idle, as an extension command may (ark3/agentpane#93)",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
		},
	});
}
`;

async function run(workspace: string, port: number, model: string, slack: number): Promise<Evidence> {
	const { home, copied } = makeStateHome(join(homedir(), ".pi", "agent"), PI_STATE_FILES, "agentpane-pi-stop-command-");
	mkdirSync(join(home, "extensions"));
	writeFileSync(join(home, "extensions", `${COMMAND}.ts`), EXTENSION);
	const serverLog = tempLogPath("agentpane-pi-stop-command-");
	let server: Server | undefined;
	const sockets: AgentpaneSocket[] = [];
	const launched = new Set<number>();
	const evidence: Evidence = {
		started_at: now(),
		workspace,
		model_flag: model,
		pi_version: cliVersion("pi"),
		state_directory: `${home} (throwaway, copies of ${copied.join(", ")}, and extensions/${COMMAND}.ts)`,
		stop_wait_ms: stopWaitMs,
		port,
	};
	let exitCode = 1;
	try {
		server = startServer(REPO, { ...process.env, PI_CODING_AGENT_DIR: home, PORT: String(port) }, serverLog);
		evidence.server_pid = server.pid;
		await waitForBuiltClient(port, server, 30);
		const socket = await AgentpaneSocket.open(port);
		sockets.push(socket);

		const created = await socket.ok("sessions/create", { cwd: workspace, backend: "pi", model }, 120);
		const handle = created.session.handle;
		for (const row of piWorkers(descendants(server.pid))) launched.add(row.pid);

		const start = socket.events.length;
		const long = await socket.ok("sessions/prompt", { handle, text: LONG_PROMPT });
		const growth = await socket.waitFor((events) => growingAssistantText(events, handle, start), 120, "the long turn's text to stream");
		evidence.long_prompt = { disposition: long.disposition, first_growth: growth };

		const commandSentAt = performance.now();
		const command = socket.request("sessions/prompt", { handle, text: `/${COMMAND}` }, 300).then((reply) => ({
			after_ms: Math.round(performance.now() - commandSentAt),
			reply,
		}));
		await sleep(1);

		const streamingAtStop = lastStreaming(socket.snapshot(), handle);
		const cut = socket.events.length;
		const stopSentAt = performance.now();
		const stop = socket.request("sessions/abort", { handle }, 120).then((reply) => ({
			after_ms: Math.round(performance.now() - stopSentAt),
			reply,
		}));
		await socket.waitFor((events) => events.slice(cut).some(([, event]) => streamingValue(event, handle) === false), 120, "the turn to report idle");
		const idleAfterMs = Math.round(performance.now() - stopSentAt);
		const [stopped, commanded] = await Promise.all([stop, command]);
		evidence.stop = {
			streaming_at_stop: streamingAtStop,
			idle_after_ms: idleAfterMs,
			abort_reply: stopped,
			command_reply: commanded,
			command_sent_before_stop_ms: Math.round(stopSentAt - commandSentAt),
		};

		const handled = commanded.reply.ok && commanded.reply.result.disposition === "handled";
		const inTime = idleAfterMs <= stopWaitMs + slack * 1000;
		evidence.checks = { command_was_handled: handled, streaming_at_stop: streamingAtStop === true, idle_within_deadline_and_slack: inTime };
		evidence.result = handled && streamingAtStop === true && inTime && stopped.reply.ok ? "pass" : "fail";
		exitCode = evidence.result === "pass" ? 0 : 1;
	} catch (error) {
		evidence.result = "error";
		evidence.error = describeError(error);
	} finally {
		evidence.server_log_tail = logTail(serverLog);
		exitCode = await finalize(evidence, exitCode, {
			server,
			sockets,
			stateHome: home,
			serverLog,
			launchedWorkers: launched,
			workerFilter: piWorkers,
		});
	}
	evidence.finished_at = now();
	evidence.exit_code = exitCode;
	return evidence;
}

async function main(): Promise<number> {
	const args = parseArgs({
		options: {
			workspace: { type: "string", default: REPO },
			port: { type: "string", default: String(PORT) },
			model: { type: "string", default: PINNED_MODEL },
			slack: { type: "string", default: "3" },
			"skip-build": { type: "boolean", default: false },
			out: { type: "string" },
		},
	}).values;
	const workspace = resolve(args.workspace!);
	if (!existsSync(workspace)) {
		console.error(`workspace does not exist: ${workspace}`);
		return 2;
	}
	const report: Record<string, unknown> = { started_at: now() };
	if (!args["skip-build"]) report.build = buildClient(REPO);
	const evidence = await run(workspace, Number(args.port), args.model!, Number(args.slack));
	Object.assign(report, evidence);
	const text = JSON.stringify(report, null, 2);
	console.log(text);
	if (args.out) writeFileSync(args.out, `${text}\n`);
	return evidence.exit_code as number;
}

if (import.meta.main) process.exit(await main());
