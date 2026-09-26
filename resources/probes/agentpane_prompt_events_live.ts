/**
 * What does agentpane put on `/api/events` for a prompt to an attached
 * Claude Code session? (OW-yirosu)
 *
 * Starts the server of the checkout named by `--root` on a free loopback
 * port, reads its event stream as raw SSE, creates a Claude session on Haiku
 * in `--workspace` (or a fresh `git init`ed scratch dir: the home server's
 * `claude` wrapper refuses a dir with no workspace marker), attaches it, and
 * sends two one-word prompts, each once the turn before has ended and at
 * least 20s after the one before. Every event for the session is printed
 * with its time since the start, runs of identical lines collapsed, and the
 * prompt's send and answer marked among them; then the snapshots each prompt
 * drew between its send and its turn's end are counted.
 * Pointing `--root` at a checkout before a change and after it is how one run
 * shows both.
 *
 * Usage:  bun agentpane_prompt_events_live.ts --root <checkout> [--workspace <git dir>]
 * Costs:  two tiny Haiku turns.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

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
const port = free.port;
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

type Event = Record<string, any>;
const events: Event[] = [];
const waiters: { predicate: () => boolean; resolve: () => void }[] = [];
function until(predicate: () => boolean, timeoutMs = 120_000): Promise<void> {
	if (predicate()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
		waiters.push({ predicate, resolve: () => (clearTimeout(timer), resolve()) });
	});
}

function describe(event: Event): string {
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
		// A path no route serves, which answers 404 and starts nothing.
		if ((await fetch(`${base}/api/sessions/claude/probe/live`)).status > 0) break;
	} catch {
		if (attempt > 100) throw new Error("server did not come up");
		await Bun.sleep(100);
	}
}

const stream = await fetch(`${base}/api/events`);
void (async () => {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream.body!) {
		buffer += decoder.decode(chunk, { stream: true });
		let end: number;
		while ((end = buffer.indexOf("\n\n")) >= 0) {
			const frame = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			for (const line of frame.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				const event = JSON.parse(line.slice(6)) as Event;
				events.push(event);
				log(describe(event), event.type === "upsert");
				for (const waiter of waiters.splice(0)) {
					if (waiter.predicate()) waiter.resolve();
					else waiters.push(waiter);
				}
			}
		}
	}
})();

const version = Bun.spawnSync(["claude", "--version"]).stdout.toString().trim();
const created = await fetch(`${base}/api/sessions`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ cwd: workspace, backend: "claude", model: MODEL }),
});
let ref = ((await created.json()) as { ref: { backend: string; id: string } }).ref;
const path = () => `${base}/api/sessions/${ref.backend}/${encodeURIComponent(ref.id)}`;
log("attach sent");
const attached = await fetch(path());
ref = ((await attached.json()) as { session: { ref: typeof ref } }).session.ref;
log(`attach answered ${attached.status}`);
// The attach's snapshot races its answer (D2); it belongs to the attach, not the first prompt.
await until(() => events.some((event) => event.type === "snapshot"));

const counts: number[] = [];
let lastSent = 0;
for (const text of PROMPTS) {
	const wait = lastSent + SPACING_MS - performance.now();
	if (lastSent && wait > 0) await Bun.sleep(wait);
	lastSent = performance.now();
	const from = events.length;
	log(`prompt sent: ${JSON.stringify(text)}`);
	const answered = await fetch(`${path()}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	log(`prompt answered ${answered.status}`);
	const ended = () => {
		const since = events.slice(from).filter((event) => "isStreaming" in event);
		return since.some((event) => event.isStreaming) && since.at(-1)?.isStreaming === false;
	};
	await until(ended);
	await Bun.sleep(1000);
	flushRepeats();
	counts.push(events.slice(from).filter((event) => event.type === "snapshot").length);
}

await fetch(path(), { method: "DELETE" });
server.kill("SIGTERM");
await server.exited;
flushRepeats();
console.log(lines.join("\n"));
console.log(`\n${version}, model ${MODEL}, root ${root}, workspace ${workspace}`);
console.log(`snapshots per prompt, send to turn end: ${JSON.stringify(counts)}`);
process.exit(0);
