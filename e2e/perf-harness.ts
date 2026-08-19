/**
 * Streaming-cost harness: how much work one SSE event actually causes.
 *
 * The real `App.svelte` and the real `controller.ts` in a real browser, driven
 * by a synthetic backend -- the same construction as `harness.ts`, and for the
 * same reason: the cost under investigation is Svelte's reactive graph plus
 * layout, and jsdom has neither a real one. What this adds over that harness is
 * a *second* session and a `flushSync` stopwatch, because the reported symptom
 * is that a session you are not looking at makes the one you are looking at
 * sluggish, and that claim needs two sessions to state at all.
 *
 * Each event is dispatched inside `flushSync`, so the measured interval covers
 * reduce -> publish -> derive -> DOM update rather than just the reducer. In
 * the shipped client every event arrives in its own EventSource callback and
 * gets its own flush, so this is the same work, merely made synchronous enough
 * to time.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { flushSync, mount } from "svelte";
import App from "../src/client/App.svelte";
import type { AgentpaneApi, EventConnection, EventHandlers } from "../src/client/api.ts";
import "../src/client/app.css";
import { createController, type AgentpaneController } from "../src/client/controller.ts";
import { assistant, toolResult, user } from "../src/client/render/samples.ts";
import type { ServerEvent, SessionRef, SessionSummary } from "../src/shared/protocol.ts";

const CWD = "/tmp/agentpane-perf";

/** Deterministic filler. Real prose length and shape, no model wording. */
const WORDS = (
	"alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike " +
	"november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu"
).split(" ");

function words(seed: number, count: number): string {
	const out: string[] = [];
	for (let i = 0; i < count; i++) out.push(WORDS[(seed * 7 + i * 13) % WORDS.length]!);
	return out.join(" ");
}

function paragraphs(seed: number, count: number): string {
	const out: string[] = [];
	for (let i = 0; i < count; i++) out.push(words(seed + i, 42));
	return out.join("\n\n");
}

function lines(seed: number, count: number): string {
	const out: string[] = [];
	for (let i = 0; i < count; i++) out.push(`${i}: ${words(seed + i, 6)}`);
	return out.join("\n");
}

function refFor(id: string): SessionRef {
	return { backend: "pi", id: `${CWD}/${id}.jsonl` };
}

function summaryFor(id: string, index: number): SessionSummary {
	return {
		ref: refFor(id),
		cwd: CWD,
		preview: `perf session ${id}`,
		createdAt: "2026-08-14T00:00:00.000Z",
		// Distinct, so the recency sort has real work rather than a stable no-op.
		updatedAt: new Date(1786419855000 + index * 1000).toISOString(),
		status: "attached",
		isStreaming: false,
	};
}

/**
 * A seeded transcript of `turns` completed turns, in Pi's observed shape: a
 * user message, an assistant message carrying thinking plus a tool call, the
 * matching tool result, then a prose message. Every fourth turn uses `edit`
 * rather than `bash`, so `EditTool`'s `buildDiff` is represented -- it is one
 * of the costs under test and a transcript of pure prose would hide it.
 */
function seedMessages(turns: number, seed: number): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (let i = 0; i < turns; i++) {
		out.push(user(`prompt ${i}: ${words(i + seed, 12)}`));
		const id = `call-${seed}-${i}`;
		const call: AgentMessage =
			i % 4 === 3
				? assistant(
						[
							{ type: "thinking", thinking: words(i, 30) },
							{
								type: "toolCall",
								id,
								name: "edit",
								arguments: {
									path: `${CWD}/file-${i}.ts`,
									edits: [{ oldText: lines(i, 24), newText: lines(i + 1, 24) }],
								},
							},
						],
						"toolUse",
					)
				: assistant(
						[
							{ type: "thinking", thinking: words(i, 30) },
							{ type: "toolCall", id, name: "bash", arguments: { command: `ls -la dir-${i}` } },
						],
						"toolUse",
					);
		out.push(call);
		out.push(toolResult(id, i % 4 === 3 ? "edit" : "bash", lines(i + 2, 20)));
		out.push(assistant([{ type: "text", text: paragraphs(i + seed, 3) }], "stop"));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Synthetic backend
// ---------------------------------------------------------------------------

interface Live {
	ref: SessionRef;
	messages: AgentMessage[];
	seq: number;
}

const live = new Map<string, Live>();
let summaries: SessionSummary[] = [];
let handlers: EventHandlers | undefined;
let controller: AgentpaneController | undefined;

function emit(event: ServerEvent): void {
	handlers?.onEvent(event);
}

function sessionOf(id: string): Live {
	let entry = live.get(id);
	if (!entry) {
		entry = { ref: refFor(id), messages: [], seq: 0 };
		live.set(id, entry);
	}
	return entry;
}

const api: AgentpaneApi = {
	async listSessions() {
		return summaries;
	},
	async createSession() {
		return refFor("a");
	},
	async attach(ref: SessionRef) {
		const id = ref.id.split("/").pop()!.replace(".jsonl", "");
		const entry = sessionOf(id);
		queueMicrotask(() => {
			entry.seq += 1;
			emit({
				type: "snapshot",
				session: entry.ref,
				seq: entry.seq,
				messages: [...entry.messages],
				isStreaming: false,
			});
		});
		return summaries.find((s) => s.ref.id === ref.id) ?? summaryFor(id, 0);
	},
	async preview(ref: SessionRef) {
		return { ref, turns: [{ role: "user" as const, text: "stored transcript" }] };
	},
	async prompt() {},
	async abort() {},
	async compact() {},
	async forkPoints() {
		return [];
	},
	async fork(ref: SessionRef) {
		return ref;
	},
	connect(next: EventHandlers): EventConnection {
		handlers = next;
		queueMicrotask(() => next.onOpen());
		return { close() {} };
	},
};

const target = document.getElementById("app");
if (!target) throw new Error("missing #app");
controller = createController(api);
mount(App, { target, props: { controller } });

// ---------------------------------------------------------------------------
// Stopwatch
// ---------------------------------------------------------------------------

export interface Stats {
	count: number;
	total: number;
	mean: number;
	median: number;
	p95: number;
	max: number;
}

function stats(samples: number[]): Stats {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	const total = samples.reduce((sum, value) => sum + value, 0);
	return {
		count: samples.length,
		total: round(total),
		mean: round(total / (samples.length || 1)),
		median: round(at(0.5)),
		p95: round(at(0.95)),
		max: round(sorted[sorted.length - 1] ?? 0),
	};
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Dispatch one event and return the wall time of the resulting flush. */
function timed(event: ServerEvent): number {
	const start = performance.now();
	flushSync(() => emit(event));
	return performance.now() - start;
}

/**
 * DOM mutations inside the transcript pane, counted across a run.
 *
 * The deterministic half of this harness, and the half a regression test can
 * assert on: a wall-clock threshold is a coin toss on a loaded machine, but
 * "an event for a session that is not on screen touched the screen" is a
 * yes/no with no timing in it. Observed with `flushSync`, so every record for
 * an event has been delivered before the next one is dispatched.
 */
let mutations = 0;
let observer: MutationObserver | undefined;

function observeTranscript(): void {
	observer?.disconnect();
	const el = document.querySelector(".conversation");
	if (!el) return;
	observer = new MutationObserver((records) => {
		mutations += records.length;
	});
	observer.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
}

export interface PerfHarness {
	/**
	 * `sessions` summaries in the sidebar; session `a` selected and seeded with
	 * `seedTurns` completed turns; session `b` present in client state, seeded
	 * with `otherTurns`, and never selected.
	 */
	setup(opts: { sessions: number; seedTurns: number; otherTurns: number }): Promise<void>;
	/**
	 * Stream `chunks` text deltas into session `id` and time each one. `a` is
	 * the selected session, `b` the background one.
	 */
	stream(id: "a" | "b", chunks: number): Stats & { mutations: number };
	/** Rendered message count of the selected transcript, as a sanity check. */
	rendered(): number;
}

const harness: PerfHarness = {
	async setup({ sessions, seedTurns, otherTurns }) {
		live.clear();
		summaries = [];
		// `a` and `b` first, then filler rows to make the sidebar realistic.
		summaries.push(summaryFor("a", 1_000_000), summaryFor("b", 999_999));
		for (let i = 0; i < Math.max(0, sessions - 2); i++) {
			summaries.push(summaryFor(`filler-${i}`, i));
		}
		sessionOf("a").messages = seedMessages(seedTurns, 1);
		sessionOf("b").messages = seedMessages(otherTurns, 2);

		await controller!.refreshSessions();
		// `b` enters client state without ever being selected -- exactly the
		// background session the symptom is about.
		const b = sessionOf("b");
		b.seq += 1;
		emit({
			type: "snapshot",
			session: b.ref,
			seq: b.seq,
			messages: [...b.messages],
			isStreaming: true,
		});
		await controller!.select(refFor("a"));
		// The attach snapshot arrives in a microtask; let it, and let layout settle.
		await new Promise((resolve) => setTimeout(resolve, 200));
		flushSync();
		observeTranscript();
	},

	stream(id, chunks) {
		const entry = sessionOf(id);
		mutations = 0;
		// A fresh assistant message at the tail, then text deltas into it: the
		// shape `reduceAssistantDelta` produces for every token.
		const index = entry.messages.length;
		entry.messages.push(assistant([], "pending"));
		timed({
			type: "upsert",
			session: entry.ref,
			seq: ++entry.seq,
			index,
			message: entry.messages[index]!,
		});
		timed({ type: "status", session: entry.ref, seq: ++entry.seq, isStreaming: true });

		const samples: number[] = [];
		let body = "";
		// `{...current, content}`, exactly as `reduceAssistantDelta` builds it
		// (`src/server/adapters/pi/reducer.ts:205`) -- in particular the timestamp
		// is *carried*, not restamped. It is part of `buildTranscript`'s key, so a
		// fresh one per delta would make every delta destroy and rebuild the tail
		// `Message` component: a cost the real client does not pay.
		const base = entry.messages[index] as ReturnType<typeof assistant>;
		for (let chunk = 0; chunk < chunks; chunk++) {
			body += (body ? " " : "") + words(chunk, 8);
			const message = { ...base, content: [{ type: "text" as const, text: body }] };
			entry.messages[index] = message;
			samples.push(
				timed({ type: "upsert", session: entry.ref, seq: ++entry.seq, index, message }),
			);
		}
		timed({ type: "status", session: entry.ref, seq: ++entry.seq, isStreaming: false });
		// `MutationObserver` delivers its records in a microtask, which `flushSync`
		// does not wait for, so the queue is drained by hand rather than trusted to
		// have been delivered by the time this returns.
		mutations += observer?.takeRecords().length ?? 0;
		return { ...stats(samples), mutations };
	},

	rendered() {
		return document.querySelectorAll(".conversation [data-index]").length;
	},
};

(globalThis as unknown as { perf: PerfHarness }).perf = harness;
