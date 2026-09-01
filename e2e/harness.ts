/**
 * The harness the browser UI suite mounts.
 *
 * The real `App.svelte` and the real `controller.ts`, mounted in a real
 * browser, driven by a synthetic backend. Nothing here is shipped: it exists
 * because jsdom cannot *discover* a layout or timing defect -- it has no
 * layout, no `ResizeObserver`, no real scroll-event timing, and no Popover
 * API, and those are what the specs beside this file are claims about.
 *
 * The synthetic backend implements the `AgentpaneApi` port directly rather
 * than mocking `fetch`/`EventSource`. That layer is already covered by
 * `api.test.ts`; what matters is that the *controller* sees a real SSE-shaped
 * event sequence in real time, which it does. The event ordering below (echoed
 * user message, assistant placeholder, only then `status:true`) is the
 * ordering a live Pi turn was observed to produce -- see OW-27's close note.
 *
 * Deliberately narrow: one session, one turn shape, no rename, no error paths.
 * This is the browser UI suite, but it has no server -- no backend, no
 * subprocess, and no production HTTP/SSE path; crossing that boundary is
 * OW-24's job. Run `bunx playwright test --list` for what the specs beside it
 * cover.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mount } from "svelte";
import App from "../src/client/App.svelte";
import type { AgentpaneApi, EventConnection, EventHandlers } from "../src/client/api.ts";
import "../src/client/app.css";
import { createController } from "../src/client/controller.ts";
import { assistant, toolResult, user } from "../src/client/render/samples.ts";
import type { ForkPoint, ServerEvent, SessionPreviewTurn, SessionRef, SessionSummary } from "../src/shared/protocol.ts";

/**
 * Window focus, faked, for the turn-done badge (OW-diyuwu).
 *
 * Headless Chromium cannot supply a genuine `document.hasFocus() === false`.
 * Playwright drives `chromium-headless-shell`, which reports every page
 * focused and visible unconditionally: probed on 2026-08-18, a second page in
 * the same context brought to the front moved neither `hasFocus` nor
 * `visibilityState`, and neither did `window.blur()` nor CDP
 * `Emulation.setFocusEmulationEnabled(false)`. The full `chromium` build,
 * which does model focus, does not launch on this machine (its crashpad
 * handler aborts at startup).
 *
 * So the badge's *decision* is proven over the pure reducer in
 * `src/client/favicon.test.ts`, and what the browser is here for is the rest
 * of the chain: a real turn through the real controller and the real
 * `App.svelte`, ending in a real `<link rel="icon">` the module had to create
 * itself, because `harness.html` declares none. Exactly one thing below is
 * stubbed, and it is the one thing the browser withholds.
 */
let focused = true;
document.hasFocus = () => focused;

const REF: SessionRef = { backend: "pi", id: "/tmp/agentpane-harness/session.jsonl" };
const CWD = "/tmp/agentpane-harness";

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

/** A few markdown paragraphs, so the rendered block has real, non-trivial height. */
function paragraphs(seed: number, count: number): string {
	const out: string[] = [];
	for (let i = 0; i < count; i++) out.push(words(seed + i, 42));
	return out.join("\n\n");
}

let seq = 0;
let messages: AgentMessage[] = [];
let handlers: EventHandlers | undefined;
/** Resolves when the in-flight turn emits its `status:false`. */
let turnSettled: Promise<void> = Promise.resolve();
/** Streaming chunks per synthetic turn, and the delay between them. */
let CHUNKS = 40;
let CHUNK_MS = 10;

function emit(event: ServerEvent): void {
	handlers?.onEvent(event);
}

function snapshot(isStreaming: boolean): void {
	seq += 1;
	emit({ type: "snapshot", session: REF, seq, messages: [...messages], isStreaming });
}

function upsert(index: number, message: AgentMessage): void {
	seq += 1;
	if (index === messages.length) messages.push(message);
	else messages[index] = message;
	emit({ type: "upsert", session: REF, seq, index, message });
}

function status(isStreaming: boolean): void {
	seq += 1;
	emit({ type: "status", session: REF, seq, isStreaming });
}

function summary(): SessionSummary {
	return {
		ref: REF,
		cwd: CWD,
		preview: "harness session",
		createdAt: "2026-08-14T00:00:00.000Z",
		updatedAt: "2026-08-14T00:00:00.000Z",
		status: "attached",
		isStreaming: false,
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One synthetic turn, in the order a live turn was observed to arrive: the
 * echoed user message and the assistant's own placeholder both land while the
 * session still reads `isStreaming:false`, and only then does `status:true`
 * follow (D2 does not guarantee cross-event ordering).
 */
async function runTurn(text: string): Promise<void> {
	upsert(messages.length, user(text));
	const assistantIndex = messages.length;
	upsert(assistantIndex, assistant([], "pending"));
	await sleep(CHUNK_MS);
	status(true);

	// Pi's real shape, and it is load-bearing here: a thinking block, then a
	// toolCall in the same message, then a separate toolResult, then a fresh
	// assistant message carrying the prose. `Thinking.svelte` keeps its
	// `<details>` open only while *it* is the streaming block, so the moment
	// the toolCall lands the thinking block collapses and the transcript
	// *shrinks* mid-turn. A transcript that only ever grows does not reproduce
	// OW-47 -- text-only turns were run to 200 seeded turns and never did.
	let thought = "";
	for (let chunk = 0; chunk < 6; chunk++) {
		await sleep(CHUNK_MS);
		thought += (thought ? " " : "") + words(chunk, 20);
		upsert(assistantIndex, assistant([{ type: "thinking", thinking: thought }], "pending"));
	}
	await sleep(CHUNK_MS);
	upsert(
		assistantIndex,
		assistant(
			[
				{ type: "thinking", thinking: thought },
				{ type: "toolCall", id: `call-${assistantIndex}`, name: "bash", arguments: { command: "ls -la" } },
			],
			"toolUse",
		),
	);
	await sleep(CHUNK_MS);
	upsert(messages.length, toolResult(`call-${assistantIndex}`, "bash", words(3, 60)));
	await sleep(CHUNK_MS);
	upsert(messages.length, assistant([], "pending"));

	const bodyIndex = messages.length - 1;
	let body = "";
	for (let chunk = 0; chunk < CHUNKS; chunk++) {
		await sleep(CHUNK_MS);
		body += (body ? " " : "") + words(chunk + messages.length, 8);
		upsert(bodyIndex, assistant([{ type: "text", text: body }], "pending"));
	}
	await sleep(CHUNK_MS);
	upsert(bodyIndex, assistant([{ type: "text", text: body }], "stop"));
	status(false);
}

const api: AgentpaneApi = {
	async listSessions() {
		return [summary()];
	},
	async createSession() {
		return REF;
	},
	async attach() {
		// The snapshot an attach triggers arrives over SSE, not in the response.
		queueMicrotask(() => snapshot(false));
		return summary();
	},
	async preview() {
		// A completed assistant turn, both turns stamped: the shape OW-75's footer
		// row is a claim about. `App.svelte` auto-previews the top session, so
		// this is what the pane shows before anything is clicked.
		return {
			ref: REF,
			turns: [
				previewTurn(user("stored transcript"), "2026-06-05T18:25:00.147Z"),
				previewTurn(assistant([{ type: "text", text: "stored answer" }]), "2026-06-05T18:25:04.912Z"),
			],
		};
	},
	async prompt(_ref, body) {
		// The route acknowledges (202) and the turn streams afterwards.
		turnSettled = runTurn(body.text);
	},
	async abort() {},
	async compact() {},
	/**
	 * One point per user message, in transcript order -- the shape both real
	 * adapters answer with, and the whole of what the client's ordinal
	 * addressing depends on (OW-hezidi).
	 */
	async forkPoints() {
		const points: ForkPoint[] = [];
		messages.forEach((message, index) => {
			if (message.role === "user") points.push({ id: `entry-${index}`, text: "" });
		});
		return points;
	},
	/**
	 * A self-fork: this harness drives one session, and what the browser is here
	 * for is the composer's mode row and the edit control's place in the block
	 * action row, not the backends' fork asymmetry -- which is the server's, and
	 * is settled live in MANUAL_TESTING.md.
	 */
	async fork() {
		return REF;
	},
	connect(next: EventHandlers): EventConnection {
		handlers = next;
		queueMicrotask(() => next.onOpen());
		return { close() {} };
	},
};

function previewTurn(message: AgentMessage, timestamp?: string): SessionPreviewTurn {
	const { timestamp: _timestamp, ...rest } = message;
	return { ...rest, ...(timestamp ? { timestamp } : {}) } as SessionPreviewTurn;
}

const target = document.getElementById("app");
if (!target) throw new Error("missing #app");
mount(App, { target, props: { controller: createController(api) } });

export interface FollowHarness {
	/** Streaming shape of a synthetic turn: how many upserts, how far apart. */
	pace(chunks: number, ms: number): void;
	/** Replace the transcript with `turns` completed user/assistant pairs and snapshot it. */
	seed(turns: number, withElidedChrome?: boolean): void;
	/** Resolves when the turn currently streaming has emitted its `status:false`. */
	settled(): Promise<void>;
	/** Live geometry of the transcript pane and the anchor the last submit armed. */
	metrics(anchorIndex: number): {
		scrollTop: number;
		scrollHeight: number;
		clientHeight: number;
		/** The anchor's top edge relative to the pane's top edge; 0 means flush at the top. */
		anchorOffset: number | null;
	};
	/** Index in `messages` of the last user message -- the anchor a submit arms. */
	lastUserIndex(): number;
	/** Move the faked window focus, and fire the event the move would fire. */
	setFocused(next: boolean): void;
}

const harness: FollowHarness = {
	pace(chunks, ms) {
		CHUNKS = chunks;
		CHUNK_MS = ms;
	},
	seed(turns, withElidedChrome = false) {
		messages = [];
		for (let i = 0; i < turns; i++) {
			messages.push(user(`prompt ${i}: ${words(i, 12)}`));
			messages.push(assistant([{ type: "text", text: paragraphs(i, 3) }], "stop"));
		}
		if (withElidedChrome) {
			const id = `seed-call-${messages.length}`;
			messages.push(
				assistant(
					[
						{ type: "thinking", thinking: words(turns, 20) },
						{ type: "toolCall", id, name: "bash", arguments: { command: "pwd" } },
					],
					"toolUse",
				),
			);
			messages.push(toolResult(id, "bash", words(turns + 1, 20)));
		}
		seq = 0;
		snapshot(false);
	},
	settled() {
		return turnSettled;
	},
	metrics(anchorIndex) {
		const el = document.querySelector<HTMLElement>(".conversation");
		if (!el) throw new Error("no .conversation");
		const anchor = el.querySelector<HTMLElement>(`[data-index="${anchorIndex}"]`);
		return {
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			anchorOffset: anchor
				? anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
				: null,
		};
	},
	lastUserIndex() {
		for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return i;
		return -1;
	},
	setFocused(next) {
		focused = next;
		window.dispatchEvent(new Event(next ? "focus" : "blur"));
	},
};

(globalThis as unknown as { harness: FollowHarness }).harness = harness;
