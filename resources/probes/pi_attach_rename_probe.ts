/**
 * Attach a stored Pi session through the production server, with no prompt,
 * and record whether the attach moves its ref and how many listing rows it
 * then has (D35 point 1, ark3/agentpane#90).
 *
 * D35 holds a live session under its current ref alone. That is safe only
 * while nothing renames a stored session on its way in: an attach that moved
 * the ref would leave the file listed once as the store's row and once as the
 * live session's. So this makes one stored session the way a user would --
 * a create on the pinned model, one short prompt, a close -- and then attaches
 * it by ref, reading every ref its new handle carries and the listing's rows
 * for that file.
 *
 * It runs against the machine's own Pi store, as `fork_attach_probe.ts` does,
 * because the server's session index reads `~/.pi/agent/sessions` whatever
 * `PI_CODING_AGENT_DIR` says (`SESSION_ROOTS.pi`), so a throwaway state
 * directory would leave a file the attach cannot find. It leaves that one
 * small session there. The model goes on the create: a resume passes none
 * (D23), so the first prompt is the only turn it charges.
 *
 * It records rather than asserts, and exits 0 when the attach made no rename
 * and the file has one listing row, 1 otherwise.
 *
 * Usage:  bun resources/probes/pi_attach_rename_probe.ts [--workspace DIR] [--port N]
 *           [--model REF] [--skip-build] [--out FILE]
 */

import { accessSync, constants, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
	AgentpaneSocket,
	REPO,
	type Server,
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
	waitForBuiltClient,
	type Evidence,
	type Stamped,
} from "./agentpane_live_support.ts";
import type { SessionRef, SessionSummary } from "../../src/shared/protocol.ts";

const PORT = 44181;
const PI_STORE = join(homedir(), ".pi/agent/sessions");

/** The listing's rows for `id`, each by what tells a store row from a live one. */
async function rowsFor(socket: AgentpaneSocket, cwd: string, id: string) {
	const listed = await socket.ok("sessions/list", { cwd });
	const row = (summary: SessionSummary) => ({ ref: summary.ref, status: summary.status, handle: summary.handle ?? null, onDisk: summary.onDisk });
	return {
		rows: listed.sessions.filter((summary) => summary.ref.backend === "pi" && summary.ref.id === id).map(row),
		attached_rows: listed.sessions.filter((summary) => summary.ref.backend === "pi" && summary.status === "attached").map(row),
	};
}

async function run(workspace: string, port: number, model: string): Promise<Evidence> {
	const scratch = mkdtempSync("/var/tmp/agentpane-pi-attach-rename-");
	const serverLog = tempLogPath("agentpane-pi-attach-rename-");
	let server: Server | undefined;
	const sockets: AgentpaneSocket[] = [];
	const launched = new Set<number>();
	const evidence: Evidence = { started_at: now(), workspace, model_flag: model, version: cliVersion("pi"), state_directory: PI_STORE, port };
	let exitCode = 1;
	try {
		// The store is the machine's own; a session that cannot write to it
		// measures nothing, so it is checked rather than redirected.
		accessSync(PI_STORE, constants.W_OK);
		evidence.store_writable = true;

		server = startServer(REPO, { ...process.env, PORT: String(port) }, serverLog);
		evidence.server_pid = server.pid;
		await waitForBuiltClient(port, server, 30);
		const socket = await AgentpaneSocket.open(port);
		sockets.push(socket);

		const created = await socket.ok("sessions/create", { cwd: workspace, backend: "pi", model }, 120);
		const createdHandle = created.session.handle;
		const createdRef: SessionRef = created.session.ref;
		evidence.create = { ref: createdRef, handle: createdHandle, model: (created.session as Record<string, unknown>).model ?? null };

		const start = socket.events.length;
		const prompt = await socket.ok("sessions/prompt", { handle: createdHandle, text: "Reply with exactly the word ONE and nothing else." });
		await socket.waitFor((events: Stamped[]) => idleAfterStreaming(events, createdHandle, start), 300, "the first turn to settle");
		const promptRefs = refsUnder(socket.snapshot(), createdHandle);
		const stored = promptRefs.at(-1)!;
		evidence.first_prompt = {
			disposition: prompt.disposition,
			refs_under_handle: promptRefs,
			moved_ref: stored.id !== createdRef.id,
			on_disk: existsSync(stored.id),
		};

		await socket.ok("sessions/close", { handle: createdHandle });
		await socket.waitFor((events: Stamped[]) => events.some(([, event]) => event.type === "ended" && event.handle === createdHandle), 30, "the close's ended");
		evidence.before_attach = await rowsFor(socket, workspace, stored.id);

		// The attach under test: by the stored ref, no prompt after it.
		const cut = socket.events.length;
		const attached = await socket.ok("sessions/attach", { ref: stored as SessionRef }, 120);
		const handle = attached.session.handle;
		// Any move the adapter made after its start would come as a snapshot
		// under the handle; give it a few seconds to arrive.
		await sleep(5);
		const attachRefs = refsUnder(socket.snapshot().slice(cut), handle);
		const after = await rowsFor(socket, workspace, stored.id);
		evidence.attach = {
			answered_ref: attached.session.ref,
			handle,
			refs_under_handle: attachRefs,
			renamed: attached.session.ref.id !== stored.id || attachRefs.some((ref) => ref.id !== stored.id),
		};
		evidence.after_attach = after;
		await socket.ok("sessions/close", { handle });

		const renamed = (evidence.attach as { renamed: boolean }).renamed;
		evidence.result = !renamed && after.rows.length === 1 && after.attached_rows.length === 1 ? "pass" : "fail";
		exitCode = evidence.result === "pass" ? 0 : 1;
	} catch (error) {
		evidence.result = "error";
		evidence.error = describeError(error);
	} finally {
		evidence.server_log_tail = logTail(serverLog);
		exitCode = await finalize(evidence, exitCode, {
			server,
			sockets,
			stateHome: scratch,
			serverLog,
			launchedWorkers: launched,
			workerFilter: (rows) => rows.filter((row) => row.comm === "pi"),
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
			model: { type: "string", default: "openrouter/deepseek/deepseek-v4.1-flash:high" },
			"skip-build": { type: "boolean", default: false },
			out: { type: "string" },
		},
	}).values;
	const workspace = resolve(args.workspace!);
	if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
		console.error(`workspace does not exist: ${workspace}`);
		return 2;
	}
	const report: Record<string, unknown> = { started_at: now() };
	if (!args["skip-build"]) report.build = buildClient(REPO);
	const evidence = await run(workspace, Number(args.port), args.model!);
	Object.assign(report, evidence);
	const text = JSON.stringify(report, null, 2);
	console.log(text);
	if (args.out) writeFileSync(args.out, `${text}\n`);
	return evidence.exit_code as number;
}

if (import.meta.main) process.exit(await main());
