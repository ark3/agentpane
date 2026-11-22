/**
 * When Pi answers a `compact` and an extension command, idle and mid-turn
 * (ark3/agentpane#12, step 1).
 *
 * `PiAdapter.abort` sends `clear_queue` only once every `prompt` already
 * written has been answered (OW-jifibo), and `PiAdapter.compact` settles on
 * Pi's `compact` reply inside the session's queue (OW-sewewe, D24). Both rest
 * on when Pi answers, which #12 says needs measuring again before its design.
 * Four cases, each in a fresh `pi --mode rpc`:
 *
 * - `idle_compact`: two priming turns, then a `compact`; where its reply falls
 *   against `compaction_start` and `compaction_end`.
 * - `midturn_compact`: the same priming, then a long prompt, and a `compact`
 *   at its first streamed update; what becomes of the running turn.
 * - `command_waits_idle`: a long prompt, and at its first update a prompt
 *   naming an extension command whose handler awaits `ctx.waitForIdle()`;
 *   when that prompt is answered against the turn's settling.
 * - `command_then_abort`: the same command, then an `abort` 1 s later, as a
 *   Stop that did not wait for the command's reply would send it.
 *
 * It drives Pi directly, not through agentpane, since Pi's own replies are
 * the subject. Pi runs in a throwaway `PI_CODING_AGENT_DIR` holding copies of
 * the machine's state files, with `compaction.keepRecentTokens` lowered to
 * 2000 so two turns leave something to compact (as `capture_fixtures.py`
 * does), and with `--no-extensions -e` loading only the probe's own command.
 * Its session files stay in that directory, and its workspace is a scratch
 * directory beside it.
 *
 * Each case's timeline starts at its long prompt, or at the `compact` for
 * `idle_compact`, with every message update between two other events folded
 * into one entry and its count. It records rather than asserts, and exits 0
 * when every case ran to its end.
 *
 * Usage:  bun resources/probes/pi_stop_compact_probe.ts [--model REF]
 *           [--case NAME]... [--keep] [--out FILE]
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { cliVersion, describeError, now, sleep } from "./agentpane_live_support.ts";

const PI_STATE_FILES = ["auth.json", "models.json", "models-store.json", "settings.json", "trust.json"];
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const COMMAND = "probe-wait-idle";
const PRIMING = [
	"Explain, in several detailed paragraphs, how the TCP/IP networking stack works from the physical layer up through the application layer. Cover framing, addressing, routing, congestion control, and at least three application protocols.",
	"Now do the same for how a modern optimizing compiler works: lexing, parsing, semantic analysis, IR, optimization passes, and code generation. Several detailed paragraphs.",
];
const LONG = "Write a detailed essay of at least 1500 words on the history of the printing press, in plain prose with no headings.";

const EXTENSION = `export default function (pi) {
	pi.registerCommand(${JSON.stringify(COMMAND)}, {
		description: "Wait for the agent to go idle, as an extension command may (ark3/agentpane#12)",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
		},
	});
}
`;

type Event = Record<string, unknown> & { type: string };
type Entry = { t_ms: number; dir: "in" | "out"; type: string; [key: string]: unknown };

/** A `pi --mode rpc` child, every line it writes kept with its arrival time. */
class Pi {
	readonly events: Array<{ t: number; event: Event }> = [];
	readonly sent: Array<{ t: number; command: Record<string, unknown> }> = [];
	readonly proc: ReturnType<typeof Bun.spawn>;
	#waiters = new Set<() => void>();
	#ids = 0;

	constructor(home: string, workspace: string, extension: string, model: string, stderr: string) {
		this.proc = Bun.spawn(["pi", "--mode", "rpc", "--session-dir", join(home, "sessions"), "--no-extensions", "-e", extension, "--model", model], {
			cwd: workspace,
			env: { ...process.env, PI_CODING_AGENT_DIR: home },
			stdin: "pipe",
			stdout: "pipe",
			stderr: Bun.file(stderr),
		});
		void this.#read();
	}

	async #read(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let event: Event;
				try {
					event = JSON.parse(line) as Event;
				} catch {
					continue;
				}
				this.events.push({ t: performance.now(), event });
				if (event.type === "extension_ui_request" && DIALOG_METHODS.has(String(event.method))) {
					this.send({ type: "extension_ui_response", id: event.id, cancelled: true });
				}
				for (const wake of this.#waiters) wake();
			}
		}
		for (const wake of this.#waiters) wake();
	}

	/** Write `command` with a fresh id, and answer the id. */
	send(command: Record<string, unknown>): string {
		const id = typeof command.id === "string" ? command.id : `probe-${++this.#ids}`;
		const full = { ...command, id };
		this.sent.push({ t: performance.now(), command: full });
		(this.proc.stdin as import("bun").FileSink).write(`${JSON.stringify(full)}\n`);
		return id;
	}

	/** The first event from index `from` on that `match` accepts, waiting up to `seconds`. */
	async waitFor(match: (event: Event) => boolean, seconds: number, what: string, from = 0): Promise<Event> {
		const deadline = performance.now() + seconds * 1000;
		for (;;) {
			const found = this.events.slice(from).find(({ event }) => match(event));
			if (found) return found.event;
			if (this.proc.exitCode !== null) throw new Error(`pi exited (${this.proc.exitCode}) before ${what}`);
			const left = deadline - performance.now();
			if (left <= 0) throw new Error(`timed out after ${seconds}s waiting for ${what}`);
			await new Promise<void>((resolve) => {
				const wake = () => {
					this.#waiters.delete(wake);
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(wake, left);
				this.#waiters.add(wake);
			});
		}
	}

	reply(id: string): (event: Event) => boolean {
		return (event) => event.type === "response" && event.id === id;
	}

	/** Send a prompt and wait for the turn it starts to settle. */
	async turn(message: string): Promise<void> {
		const from = this.events.length;
		this.send({ type: "prompt", message });
		await this.waitFor((event) => event.type === "agent_settled", 300, "a priming turn to settle", from);
	}

	/** Every event and command from `since` on, with message updates folded into a count. */
	timeline(since: number): Entry[] {
		const merged: Entry[] = [
			...this.sent.filter(({ t }) => t >= since).map(({ t, command }) => ({ t_ms: Math.round(t - since), dir: "out" as const, ...command, type: String(command.type) })),
			...this.events.filter(({ t }) => t >= since).map(({ t, event }) => ({ ...summarise(event), t_ms: Math.round(t - since), dir: "in" as const })),
		].sort((a, b) => a.t_ms - b.t_ms);
		const folded: Entry[] = [];
		for (const entry of merged) {
			const last = folded.at(-1);
			if (entry.type === "message_update" && last?.type === "message_update") {
				last.count = (last.count as number) + 1;
				last.last_t_ms = entry.t_ms;
			} else folded.push(entry.type === "message_update" ? { ...entry, count: 1 } : entry);
		}
		return folded;
	}

	async stop(): Promise<number | null> {
		try {
			(this.proc.stdin as import("bun").FileSink).end();
		} catch {}
		const exited = await Promise.race([this.proc.exited, sleep(5).then(() => null)]);
		if (exited === null) this.proc.kill("SIGKILL");
		return this.proc.exitCode;
	}
}

/** What of an event the question needs: never the model's text. */
function summarise(event: Event): Entry {
	const keep: Entry = { t_ms: 0, dir: "in", type: event.type };
	for (const key of ["id", "command", "success", "error", "aborted", "reason", "willRetry", "errorMessage"]) {
		if (key in event) keep[key] = event[key];
	}
	if (event.type === "response" && event.data && typeof event.data === "object") {
		const data = event.data as Record<string, unknown>;
		keep.data_keys = Object.keys(data);
		if ("disposition" in data) keep.disposition = data.disposition;
	}
	if (event.type === "message_end" || event.type === "agent_end") {
		const message = (event.message ?? (event.messages as unknown[] | undefined)?.at(-1)) as Record<string, unknown> | undefined;
		if (message) {
			keep.role = message.role;
			if ("stopReason" in message) keep.stopReason = message.stopReason;
			if (message.errorMessage) keep.messageError = message.errorMessage;
		}
	}
	return keep;
}

function stateHome(): { home: string; workspace: string; extension: string } {
	const root = mkdtempSync("/var/tmp/agentpane-pi-stop-compact-");
	const home = join(root, "agent");
	const workspace = join(root, "workspace");
	mkdirSync(home);
	mkdirSync(workspace);
	const real = join(homedir(), ".pi/agent");
	for (const name of PI_STATE_FILES) if (existsSync(join(real, name))) copyFileSync(join(real, name), join(home, name));
	const settingsPath = join(home, "settings.json");
	const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>) : {};
	settings.compaction = { ...((settings.compaction as object | undefined) ?? {}), enabled: true, keepRecentTokens: 2000 };
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	const extension = join(root, "probe-wait-idle.ts");
	writeFileSync(extension, EXTENSION);
	return { home: root, workspace, extension };
}

type Case = (pi: Pi) => Promise<number>;

const CASES: Record<string, Case> = {
	async idle_compact(pi) {
		for (const prompt of PRIMING) await pi.turn(prompt);
		const since = performance.now();
		const id = pi.send({ type: "compact" });
		await pi.waitFor(pi.reply(id), 300, "the compact's reply");
		await sleep(2);
		return since;
	},
	async midturn_compact(pi) {
		for (const prompt of PRIMING) await pi.turn(prompt);
		const from = pi.events.length;
		const since = performance.now();
		pi.send({ type: "prompt", message: LONG });
		await pi.waitFor((event) => event.type === "message_update", 120, "the long turn's first update", from);
		const id = pi.send({ type: "compact" });
		await pi.waitFor(pi.reply(id), 300, "the compact's reply");
		await sleep(3);
		return since;
	},
	async command_waits_idle(pi) {
		const from = pi.events.length;
		const since = performance.now();
		pi.send({ type: "prompt", message: LONG });
		await pi.waitFor((event) => event.type === "message_update", 120, "the long turn's first update", from);
		const id = pi.send({ type: "prompt", message: `/${COMMAND}` });
		await pi.waitFor(pi.reply(id), 300, "the command's reply");
		await sleep(2);
		return since;
	},
	async command_then_abort(pi) {
		const from = pi.events.length;
		const since = performance.now();
		pi.send({ type: "prompt", message: LONG });
		await pi.waitFor((event) => event.type === "message_update", 120, "the long turn's first update", from);
		const command = pi.send({ type: "prompt", message: `/${COMMAND}` });
		await sleep(1);
		const abort = pi.send({ type: "abort" });
		await pi.waitFor(pi.reply(abort), 120, "the abort's reply");
		await pi.waitFor(pi.reply(command), 120, "the command's reply");
		await sleep(2);
		return since;
	},
};

async function main(): Promise<number> {
	const args = parseArgs({
		options: {
			model: { type: "string", default: "openrouter/deepseek/deepseek-v4.1-flash:high" },
			case: { type: "string", multiple: true },
			keep: { type: "boolean", default: false },
			out: { type: "string" },
		},
	}).values;
	const names = args.case?.length ? args.case : Object.keys(CASES);
	const unknown = names.filter((name) => !(name in CASES));
	if (unknown.length) {
		console.error(`unknown case: ${unknown.join(", ")}; known: ${Object.keys(CASES).join(", ")}`);
		return 2;
	}
	const { home, workspace, extension } = stateHome();
	const report: Record<string, unknown> = {
		started_at: now(),
		version: cliVersion("pi"),
		model_flag: args.model,
		state_directory: `${home}/agent (throwaway, copies of ${PI_STATE_FILES.join(", ")})`,
		cases: {},
	};
	let exitCode = 0;
	for (const name of names) {
		const stderr = join(home, `${name}.stderr`);
		const pi = new Pi(join(home, "agent"), workspace, extension, args.model!, stderr);
		const result: Record<string, unknown> = { started_at: now() };
		try {
			const since = await CASES[name]!(pi);
			result.timeline = pi.timeline(since);
			result.result = "ran";
		} catch (error) {
			exitCode = 1;
			result.result = "error";
			result.error = describeError(error);
			result.timeline = pi.timeline(pi.sent[0]?.t ?? 0);
		}
		result.exit_code = await pi.stop();
		result.stderr_tail = existsSync(stderr) ? readFileSync(stderr, "utf8").split("\n").slice(-10).join("\n") : "";
		(report.cases as Record<string, unknown>)[name] = result;
	}
	report.finished_at = now();
	if (!args.keep) rmSync(home, { recursive: true, force: true });
	else report.kept = home;
	const text = JSON.stringify(report, null, 2);
	console.log(text);
	if (args.out) writeFileSync(args.out, `${text}\n`);
	return exitCode;
}

if (import.meta.main) process.exit(await main());
