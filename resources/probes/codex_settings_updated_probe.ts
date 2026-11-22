/**
 * Record when `codex app-server` sends `thread/settings/updated`, against the
 * replies `CodexAdapter` writes a thread's model and effort from (D34 point 5,
 * ark3/agentpane#83).
 *
 * The adapter takes `model`, `modelProvider` and `reasoningEffort` from the
 * `thread/start` and `thread/resume` replies. Moving them onto the event needs
 * to know whether the event follows each of those requests, and a `turn/start`
 * that overrides the effort, in which order against the reply, and what it
 * carries. So this drives app-server directly over stdio, sending what the
 * adapter sends, and after each reply waits a quiet period to catch a late
 * event:
 *
 *   - app-server 1: `thread/start` naming the model; a `turn/start` at the
 *     effort `--effort` names, one at the same effort, and one naming neither;
 *     a `thread/resume` of the thread it holds (a re-attach); a `thread/fork`
 *     and the borrower's `thread/resume` of the fork.
 *   - app-server 2, fresh: a `thread/resume` naming no model (a cold attach).
 *   - app-server 3, fresh: a `thread/resume` naming the model.
 *   - app-server 4, fresh, with `initialize`'s experimental API, which the
 *     adapter never asks for: a `thread/start`, a `turn/start` at `--effort`,
 *     and one naming the collaboration mode `plan`, as the one earlier
 *     sighting of the event, `plan.jsonl` on `codex-cli 0.157.1`, did.
 *
 * Each app-server's stdout is kept, scrubbed by key as `capture_fixtures.py`
 * scrubs, as `resources/fixtures/codex/settings-<n>.jsonl` beside a
 * `.meta.json` carrying the steps; `--no-fixtures` keeps them out. It runs
 * under a throwaway `CODEX_HOME` holding copies of `auth.json` and
 * `config.toml`, so the threads it makes never reach the machine's store.
 * It records rather than asserts, and exits 0 when every request answered.
 *
 * Usage:  bun resources/probes/codex_settings_updated_probe.ts [--model M]
 *           [--effort E] [--quiet SECONDS] [--no-fixtures] [--out FILE]
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { REPO, cliVersion, makeStateHome, now, sleep } from "./agentpane_live_support.ts";

const FIXTURES = join(REPO, "resources/fixtures/codex");
const SANDBOX = "danger-full-access";
const APPROVAL_POLICY = "never";
const PROMPT = "Reply with exactly the word OK and nothing else.";

type Json = Record<string, any>;
interface Line {
	at: number;
	text: string;
	msg: Json | null;
}

/** One app-server over stdio, every stdout line kept in order. */
class AppServer {
	readonly lines: Line[] = [];
	private proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
	private nextId = 1;
	private waiters: { test: (msg: Json) => boolean; resolve: (index: number) => void }[] = [];
	private done: Promise<void>;

	constructor(model: string, cwd: string, home: string) {
		this.proc = Bun.spawn(["codex", "-m", model, "app-server"], {
			cwd,
			env: { ...process.env, CODEX_HOME: home },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});
		this.done = this.read();
	}

	/** Split on LF bytes only: Codex emits raw U+2028 inside JSON strings. */
	private async read(): Promise<void> {
		let pending = new Uint8Array(0);
		const decoder = new TextDecoder();
		for await (const chunk of this.proc.stdout) {
			const merged = new Uint8Array(pending.length + chunk.length);
			merged.set(pending);
			merged.set(chunk, pending.length);
			let start = 0;
			for (let i = 0; i < merged.length; i++) {
				if (merged[i] !== 0x0a) continue;
				const text = decoder.decode(merged.subarray(start, i));
				start = i + 1;
				if (text.trim()) this.push(text);
			}
			pending = merged.slice(start);
		}
	}

	private push(text: string): void {
		let msg: Json | null = null;
		try {
			msg = JSON.parse(text);
		} catch {}
		const index = this.lines.push({ at: Date.now(), text, msg }) - 1;
		if (!msg) return;
		this.waiters = this.waiters.filter((waiter) => {
			if (!waiter.test(msg)) return true;
			waiter.resolve(index);
			return false;
		});
	}

	/** Index of the first line from `from` on that passes `test`, waiting up to `seconds`. */
	waitFor(test: (msg: Json) => boolean, seconds: number, from = 0): Promise<number | null> {
		const seen = this.lines.findIndex((line, index) => index >= from && line.msg !== null && test(line.msg));
		if (seen >= 0) return Promise.resolve(seen);
		return new Promise((resolve) => {
			const waiter = { test, resolve };
			this.waiters.push(waiter);
			setTimeout(() => {
				this.waiters = this.waiters.filter((other) => other !== waiter);
				resolve(null);
			}, seconds * 1000);
		});
	}

	/** Send a request; resolves with the index it went out at and its reply's. */
	async request(method: string, params: Json, seconds = 60): Promise<{ id: number; sentAt: number; reply: number | null }> {
		const id = this.nextId++;
		const sentAt = this.lines.length;
		this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		this.proc.stdin.flush();
		const reply = await this.waitFor((msg) => msg.id === id && !("method" in msg), seconds);
		return { id, sentAt, reply };
	}

	async stop(): Promise<void> {
		this.proc.stdin.end();
		this.proc.kill();
		await this.proc.exited;
		await this.done;
	}
}

/** What a `thread/settings/updated` carries, beside its line's index. */
function settingsOf(index: number, msg: Json) {
	const s = msg.params?.threadSettings ?? {};
	return {
		index,
		threadId: msg.params?.threadId,
		model: s.model,
		modelProvider: s.modelProvider,
		effort: s.effort,
		summary: s.summary,
		collaborationMode: s.collaborationMode?.mode,
		collaborationEffort: s.collaborationMode?.settings?.reasoning_effort,
	};
}

/**
 * One request and what followed it: every `thread/settings/updated` between
 * its going out and `until` (the quiet period's end), each placed before or
 * after the reply, and the reply's own model and effort.
 */
function step(server: AppServer, label: string, sent: { sentAt: number; reply: number | null }, sentParams: Json, until: number) {
	const reply = sent.reply === null ? null : server.lines[sent.reply].msg;
	const result = reply?.result ?? {};
	const events = [];
	const methods: string[] = [];
	for (let index = sent.sentAt; index < until; index++) {
		const msg = server.lines[index].msg;
		if (!msg) continue;
		methods.push(index === sent.reply ? "<reply>" : (msg.method ?? `<reply ${msg.id}>`));
		if (msg.method === "thread/settings/updated") {
			events.push({ ...settingsOf(index, msg), relative: sent.reply === null ? "no reply" : index < sent.reply ? "before reply" : "after reply" });
		}
	}
	return {
		label,
		sent: { model: sentParams.model ?? null, effort: sentParams.effort ?? null },
		reply_index: sent.reply,
		reply_error: reply?.error ?? null,
		reply: { model: result.model, modelProvider: result.modelProvider, reasoningEffort: result.reasoningEffort, threadStatus: result.thread?.status?.type },
		settings_updated: events,
		lines_in_order: methods.filter((method) => !method.startsWith("mcpServer/") && !method.startsWith("item/") && !method.startsWith("account/")),
	};
}

// -- scrub, as `capture_fixtures.py` does --------------------------------------

const SCRUB_KEYS: Record<string, string> = {
	model: "example-model",
	provider: "example-provider",
	modelProvider: "example-provider",
	api: "example-api-stream",
	serverName: "example-mcp-server",
	userAgent: "agentpane-fixture-probe/0.0.0 (example-os; x86_64)",
};

function collect(value: unknown, found: Map<string, string>): void {
	if (Array.isArray(value)) for (const item of value) collect(item, found);
	else if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			if (key in SCRUB_KEYS && typeof item === "string" && item) found.set(item, SCRUB_KEYS[key]);
			collect(item, found);
		}
	}
}

/** By-key values replaced as quoted strings; account telemetry nulled; the home path replaced. */
function scrub(lines: Line[]): string[] {
	const found = new Map<string, string>();
	for (const line of lines) collect(line.msg, found);
	const home = homedir();
	return lines.map(({ text }) => {
		for (const [real, placeholder] of found) text = text.replaceAll(JSON.stringify(real), JSON.stringify(placeholder));
		text = text.replaceAll(home, "/example-home");
		let msg: Json;
		try {
			msg = JSON.parse(text);
		} catch {
			return text;
		}
		if (msg.method === "account/rateLimits/updated" && msg.params?.rateLimits) {
			msg.params.rateLimits = Object.fromEntries(Object.entries(msg.params.rateLimits).map(([key, value]) => [key, key === "limitId" ? value : null]));
			return JSON.stringify(msg);
		}
		if (msg.method === "account/updated" && msg.params && "planType" in msg.params) {
			msg.params.planType = null;
			return JSON.stringify(msg);
		}
		return text;
	});
}

function census(lines: Line[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const { msg } of lines) {
		const key = msg?.method ?? "<response>";
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

// -- the run -------------------------------------------------------------------

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			model: { type: "string", default: "gpt-5.6-luna" },
			effort: { type: "string", default: "low" },
			quiet: { type: "string", default: "3" },
			"no-fixtures": { type: "boolean", default: false },
			out: { type: "string" },
		},
	});
	const model = values.model!;
	const effort = values.effort!;
	const quiet = Number(values.quiet);
	const version = cliVersion("codex");
	const { home, copied } = makeStateHome(join(homedir(), ".codex"), ["auth.json", "config.toml"], "agentpane-codex-settings-");
	const work = mkdtempSync("/var/tmp/agentpane-codex-settings-work-");
	Bun.spawnSync(["git", "init", "-q"], { cwd: work });
	const evidence: Json = {
		started_at: now(),
		cli_version: version,
		command: `codex -m ${model} app-server`,
		state_directory: "throwaway CODEX_HOME under /var/tmp",
		copied_state_files: copied,
		turn_effort: effort,
		quiet_seconds: quiet,
		servers: [],
	};
	const servers: { server: AppServer; covers: string; steps: Json[] }[] = [];
	let answered = true;

	/** Send, wait for the reply, then the quiet period, and record the step. */
	const run = async (server: AppServer, steps: Json[], label: string, method: string, params: Json, settle?: (from: number) => Promise<unknown>) => {
		const sent = await server.request(method, params);
		if (sent.reply === null || server.lines[sent.reply].msg?.error) answered = false;
		if (settle && sent.reply !== null) await settle(sent.reply);
		await sleep(quiet);
		const recorded = step(server, label, sent, params, server.lines.length);
		steps.push(recorded);
		console.log(`${label}: reply ${JSON.stringify(recorded.reply)}; settings/updated ${JSON.stringify(recorded.settings_updated)}`);
		return server.lines[sent.reply ?? 0]?.msg?.result ?? {};
	};
	const init = (server: AppServer, steps: Json[], experimental = false) =>
		run(server, steps, "initialize", "initialize", {
			clientInfo: { name: "agentpane-settings-probe", version: "0", title: "agentpane" },
			capabilities: experimental ? { experimentalApi: true } : null,
		});
	const thread = (extra: Json = {}) => ({ cwd: work, sandbox: SANDBOX, approvalPolicy: APPROVAL_POLICY, ...extra });
	const turn = (server: AppServer, steps: Json[], threadId: string, label: string, extra: Json) =>
		run(server, steps, label, "turn/start", { threadId, input: [{ type: "text", text: PROMPT }], ...extra }, (from) =>
			server.waitFor((msg) => msg.method === "turn/completed" && msg.params?.threadId === threadId, 180, from),
		);

	try {
		// app-server 1: start, three turns, a re-attach, a fork and its borrower.
		const one = { server: new AppServer(model, work, home), covers: "thread/start, turn/start overrides, a re-attach and a fork's resume on one app-server", steps: [] as Json[] };
		servers.push(one);
		await init(one.server, one.steps);
		const started = await run(one.server, one.steps, "thread/start (model named)", "thread/start", thread({ model }));
		const threadId: string = started.thread?.id;
		if (!threadId) throw new Error("thread/start answered no thread");
		evidence.thread_id = threadId;
		await turn(one.server, one.steps, threadId, `turn/start (model, effort ${effort}: an override)`, { model, effort });
		await turn(one.server, one.steps, threadId, `turn/start (model, effort ${effort} again: no change)`, { model, effort });
		await turn(one.server, one.steps, threadId, "turn/start (neither named)", {});
		await run(one.server, one.steps, "thread/resume on the holding app-server (re-attach, no model)", "thread/resume", { threadId, ...thread(), excludeTurns: true });
		const forked = await run(one.server, one.steps, "thread/fork (whole thread)", "thread/fork", { threadId, ...thread(), excludeTurns: true });
		const forkId: string | undefined = forked.thread?.id;
		evidence.fork_id = forkId ?? null;
		if (forkId) await run(one.server, one.steps, "thread/resume of the fork (the borrower)", "thread/resume", { threadId: forkId, ...thread(), excludeTurns: true });
		await one.server.stop();

		// app-servers 2 and 3: a cold attach, naming no model and naming one.
		for (const named of [false, true]) {
			const fresh = { server: new AppServer(model, work, home), covers: `a cold thread/resume naming ${named ? "the model" : "no model"}`, steps: [] as Json[] };
			servers.push(fresh);
			await init(fresh.server, fresh.steps);
			await run(fresh.server, fresh.steps, `thread/resume on a fresh app-server (${named ? "model named" : "no model"})`, "thread/resume", {
				threadId,
				...thread(named ? { model } : {}),
				excludeTurns: true,
			});
			await fresh.server.stop();
		}

		// app-server 4: what the one earlier sighting had and agentpane never
		// sends, `initialize`'s experimental API and a `turn/start` naming a
		// collaboration mode (`plan.jsonl`, `codex-cli 0.157.1`), beside an
		// effort override on the same connection.
		const four = { server: new AppServer(model, work, home), covers: "an effort override and a collaborationMode override under initialize's experimental API", steps: [] as Json[] };
		servers.push(four);
		await init(four.server, four.steps, true);
		const second = await run(four.server, four.steps, "thread/start (model named, experimental API)", "thread/start", thread({ model }));
		const secondId: string = second.thread?.id;
		if (!secondId) throw new Error("thread/start answered no thread");
		evidence.experimental_thread_id = secondId;
		await turn(four.server, four.steps, secondId, `turn/start (model, effort ${effort}: an override, experimental API)`, { model, effort });
		await turn(four.server, four.steps, secondId, "turn/start (collaborationMode plan, as plan.jsonl's)", {
			collaborationMode: { mode: "plan", settings: { model, reasoning_effort: null, developer_instructions: null } },
		});
		await four.server.stop();
	} catch (error) {
		evidence.error = error instanceof Error ? error.message : String(error);
		answered = false;
		for (const { server } of servers) await server.stop().catch(() => {});
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}

	servers.forEach(({ server, covers, steps }, i) => {
		const name = `settings-${i + 1}`;
		(evidence.servers as Json[]).push({ fixture: name, covers, lines: server.lines.length, steps });
		if (values["no-fixtures"]) return;
		writeFileSync(join(FIXTURES, `${name}.jsonl`), `${scrub(server.lines).join("\n")}\n`);
		const meta = {
			backend: "codex",
			scenario: name,
			covers,
			probe: "resources/probes/codex_settings_updated_probe.ts",
			prompt: PROMPT,
			cli_version: version,
			captured_at: evidence.started_at,
			command: evidence.command,
			lines: server.lines.length,
			thread_id: evidence.thread_id ?? null,
			fork_id: evidence.fork_id ?? null,
			experimental_thread_id: evidence.experimental_thread_id ?? null,
			server_requests_seen: [],
			event_census: census(server.lines),
			steps,
		};
		writeFileSync(join(FIXTURES, `${name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
	});
	evidence.finished_at = now();
	evidence.result = answered ? "every request answered" : "a request went unanswered or failed";
	const text = `${JSON.stringify(evidence, null, 2)}\n`;
	if (values.out) writeFileSync(values.out, text);
	else console.log(text);
	return answered ? 0 : 1;
}

process.exit(await main());
