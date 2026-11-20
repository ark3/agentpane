/**
 * What does agentpane send on its socket for a prompt to an attached Claude
 * Code session? (OW-yirosu)
 *
 * Starts the server of the checkout named by `--root` on a free loopback
 * port, says `hello` on its socket (D31), creates a Claude session on Haiku
 * in `--workspace` (or a fresh `git init`ed scratch dir: the home server's
 * `claude` wrapper refuses a dir with no workspace marker), which attaches it
 * (D30), and sends two one-word prompts by its handle, each once the turn
 * before has ended and at least 20s after the one before. Every event is
 * printed with its time since the start, runs of identical lines collapsed,
 * and each command's send and reply marked among them; then the snapshots
 * each prompt drew between its send and its turn's end are counted.
 * Pointing `--root` at a checkout before a change and after it is how one run
 * shows both, back to ark3/agentpane#52, which added the socket; this probe
 * read the event stream as raw SSE until ark3/agentpane#54.
 *
 * Usage:  bun agentpane_prompt_events_live.ts --root <checkout> [--workspace <git dir>]
 * Costs:  two tiny Haiku turns.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AgentpaneSocket, type WireEvent } from "./agentpane_live_support.ts";

// Home-server agent sessions pin Claude Code to one model (AGENTS.md, "Evidence").
const MODEL = "haiku";
const PROMPTS = ["Reply with exactly one word: one", "Reply with exactly one word: two"];
const SPACING_MS = 20_000;

const { values } = parseArgs({ options: { root: { type: "string" }, workspace: { type: "string" } } });
if (!values.root) throw new Error("need --root");
const root = values.root;

let workspace = values.workspace;
if (!workspace) {
	workspace = mkdtempSync(join(tmpdir(), "agentpane-prompt-events-"));
	Bun.spawnSync(["git", "init", "-q", workspace]);
}

const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = free.port!;
free.stop(true);
const base = `http://127.0.0.1:${port}`;

const server = Bun.spawn(["bun", "run", `${root}/src/server/index.ts`], {
	cwd: root,
	env: { ...process.env, PORT: String(port) },
	stdout: "ignore",
	stderr: "inherit",
});

const started = performance.now();
const at = () => ((performance.now() - started) / 1000).toFixed(2).padStart(6);
let last = "";
let repeats = 0;
const lines: string[] = [];
function flushRepeats(): void {
	if (repeats > 1) lines[lines.length - 1] += `  (x${repeats})`;
	repeats = 0;
	last = "";
}
function log(line: string, collapse = false): void {
	if (collapse && line === last) {
		repeats++;
		return;
	}
	flushRepeats();
	lines.push(`${at()}  ${line}`);
	if (collapse) {
		last = line;
		repeats = 1;
	}
}

const events: WireEvent[] = [];
const waiters: { predicate: () => boolean; resolve: () => void }[] = [];
function until(predicate: () => boolean, timeoutMs = 120_000): Promise<void> {
	if (predicate()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
		waiters.push({ predicate, resolve: () => (clearTimeout(timer), resolve()) });
	});
}

function describe(event: WireEvent): string {
	switch (event.type) {
		case "snapshot":
			return `snapshot  messages=${event.messages.length} isStreaming=${event.isStreaming} error=${JSON.stringify(event.error)}`;
		case "upsert":
			return `upsert    index=${event.index} role=${event.message.role}`;
		case "status":
			return `status    isStreaming=${event.isStreaming} compaction=${event.compaction}`;
		default:
			return event.type;
	}
}

for (let attempt = 0; ; attempt++) {
	try {
		// Outside `/api`, so it needs no token, and any answer means listening.
		if ((await fetch(`${base}/`)).status > 0) break;
	} catch {
		if (attempt > 100) throw new Error("server did not come up");
		await Bun.sleep(100);
	}
}

// The `hello` reads the token from its file only now that the server is
// listening, since its first start is what creates it.
const socket = await AgentpaneSocket.open(port);
socket.onEvent = (event) => {
	events.push(event);
	log(describe(event), event.type === "upsert");
	for (const waiter of waiters.splice(0)) {
		if (waiter.predicate()) waiter.resolve();
		else waiters.push(waiter);
	}
};

const version = Bun.spawnSync(["claude", "--version"]).stdout.toString().trim();
log("create sent");
const created = await socket.ok("sessions/create", { cwd: workspace, backend: "claude", model: MODEL }, 120);
const { handle, ref } = created.session;
log(`create answered, handle ${handle}`);

const counts: number[] = [];
let lastSent = 0;
for (const text of PROMPTS) {
	const wait = lastSent + SPACING_MS - performance.now();
	if (lastSent && wait > 0) await Bun.sleep(wait);
	lastSent = performance.now();
	const from = events.length;
	log(`prompt sent: ${JSON.stringify(text)}`);
	const answered = await socket.request("sessions/prompt", { handle, text });
	log(`prompt answered ${answered.ok ? `ok ${JSON.stringify(answered.result)}` : `${answered.code} ${answered.detail}`}`);
	const ended = () => {
		const since = events.slice(from).filter((event) => event.handle === handle && "isStreaming" in event);
		return since.some((event) => event.isStreaming) && since.at(-1)?.isStreaming === false;
	};
	await until(ended);
	await Bun.sleep(1000);
	flushRepeats();
	counts.push(events.slice(from).filter((event) => event.type === "snapshot").length);
}

await socket.request("sessions/close", { ref });
await socket.close();
server.kill("SIGTERM");
await server.exited;
flushRepeats();
console.log(lines.join("\n"));
console.log(`\n${version}, model ${MODEL}, root ${root}, workspace ${workspace}`);
console.log(`snapshots per prompt, send to turn end: ${JSON.stringify(counts)}`);
process.exit(0);
