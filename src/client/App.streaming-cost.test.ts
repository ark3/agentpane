/**
 * What one SSE event costs the renderer, counted rather than timed (OW-detepa).
 *
 * The reported symptom was that streaming went sluggish, worst when the session
 * doing the streaming was not the one on screen. The cause was `view` being a
 * deep `$state`: `publish()` swaps the whole `ControllerView` per event, a fresh
 * root proxy rebuilds the whole tree, and every settled markdown block in the
 * *selected* transcript re-parsed -- for an event belonging to another session.
 *
 * Counts, not milliseconds: a wall-clock threshold is a coin toss on a loaded
 * machine, while "an event for a session that is not on screen re-parsed the
 * transcript" is a yes/no. `renderMarkdownWithFences` is the hot half of that
 * work (DOMPurify plus marked), so it is what the spy wraps.
 */

import { render } from "@testing-library/svelte";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { flushSync, tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionKey, type BackendId, type ServerEvent, type SessionRef, type SessionSummary } from "$shared/protocol.ts";

const { parses } = vi.hoisted(() => ({ parses: vi.fn() }));

// `importOriginal`, so the renderer under test is the real one and the only
// change is that every parse is counted.
vi.mock("./render/markdown.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./render/markdown.ts")>();
	return {
		...actual,
		renderMarkdownWithFences(...args: Parameters<typeof actual.renderMarkdownWithFences>) {
			parses(...args);
			return actual.renderMarkdownWithFences(...args);
		},
	};
});

import App from "./App.svelte";
import type { AgentpaneController, ControllerView } from "./controller.ts";
import { assistant, user } from "./render/samples.ts";
import { initialClientState, reduceServerEvent, type ClientState } from "./session-state.ts";

const selectedRef: SessionRef = { backend: "pi", id: "selected" };
const backgroundRef: SessionRef = { backend: "pi", id: "background" };

/**
 * A controller that publishes the way `controller.ts`'s `publish()` does: a
 * fresh view object, then every listener. `App.test.ts`'s `FakeController` is
 * not usable here (OW-42) -- what is under test *is* the publish, so a fake
 * that hands back the same object would make the count zero for the wrong
 * reason.
 */
class PublishingController implements AgentpaneController {
	private readonly listeners = new Set<(next: ControllerView) => void>();

	constructor(private current: ControllerView) {}

	getView(): ControllerView {
		return this.current;
	}

	subscribe(listener: (next: ControllerView) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onRename() {
		return () => {};
	}

	publish(next: Partial<ControllerView>): void {
		this.current = { ...this.current, ...next };
		for (const listener of this.listeners) listener(this.current);
	}

	/** One SSE event, through the real reducer and out through the real publish. */
	deliver(event: ServerEvent): void {
		flushSync(() => this.publish({ state: reduceServerEvent(this.current.state, event).state }));
	}

	async start() {}
	dispose() {}
	setDraft() {}
	async editDraft() {}
	async create(_cwd: string, _backend: BackendId) {}
	async preview(_ref: SessionRef) {}
	async select(_ref: SessionRef) {}
	async submit() {}
	async forkAndSubmit() {
		return false;
	}
	async abort() {}
	async compact() {}
	async refreshSessions() {}
	async refreshPreview() {}
	clearError() {}
}

function summary(ref: SessionRef, updatedAt: string): SessionSummary {
	return {
		ref,
		cwd: "/work/project",
		preview: ref.id,
		createdAt: null,
		updatedAt,
		status: "attached",
		isStreaming: false,
	};
}

/** `turns` settled turns of prose: a user message and an assistant reply each. */
function transcript(turns: number): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (let i = 0; i < turns; i += 1) {
		out.push(user(`prompt ${i}\n\nwith a second paragraph`));
		out.push(assistant([{ type: "text", text: `reply ${i}\n\n- one\n- two` }], "stop"));
	}
	return out;
}

function state(selectedTurns: number): ClientState {
	const session = (ref: SessionRef, messages: AgentMessage[]) => ({
		ref,
		messages,
		isStreaming: false,
		seq: 1,
		error: null,
		requests: [],
	});
	return {
		...initialClientState(),
		summaries: [
			summary(selectedRef, "2026-06-02T00:00:00.000Z"),
			summary(backgroundRef, "2026-06-01T00:00:00.000Z"),
		],
		selected: selectedRef,
		sessions: {
			[sessionKey(selectedRef)]: session(selectedRef, transcript(selectedTurns)),
			[sessionKey(backgroundRef)]: session(backgroundRef, []),
		},
	};
}

function initialView(selectedTurns: number): ControllerView {
	return {
		state: state(selectedTurns),
		draft: "",
		connection: "connected",
		busy: "idle",
		error: null,
		preview: null,
	};
}

/**
 * Ten text deltas into `ref`'s tail message, the shape `reduceAssistantDelta`
 * produces per token: a fresh assistant message at the end, then the same
 * message re-sent with a longer body. The timestamp is carried, not restamped,
 * because it is part of `buildTranscript`'s key -- restamping it would destroy
 * and rebuild the tail `Message`, a cost the real client does not pay.
 */
function streamTen(controller: PublishingController, ref: SessionRef): number {
	const key = sessionKey(ref);
	const index = controller.getView().state.sessions[key]!.messages.length;
	const base = assistant([], "pending");
	let seq = 1;
	controller.deliver({ type: "upsert", session: ref, seq: (seq += 1), index, message: base });

	const before = parses.mock.calls.length;
	let body = "";
	for (let chunk = 0; chunk < 10; chunk += 1) {
		body += `${body ? " " : ""}token-${chunk}`;
		controller.deliver({
			type: "upsert",
			session: ref,
			seq: (seq += 1),
			index,
			message: { ...base, content: [{ type: "text", text: body }] },
		});
	}
	return parses.mock.calls.length - before;
}

async function mounted(selectedTurns: number): Promise<PublishingController> {
	const controller = new PublishingController(initialView(selectedTurns));
	render(App, { props: { controller } });
	await tick();
	flushSync();
	return controller;
}

describe("streaming cost (OW-detepa)", () => {
	beforeEach(() => {
		parses.mockClear();
	});

	it("re-parses nothing in the selected transcript for a session that is not on screen", async () => {
		const controller = await mounted(8);

		const calls = streamTen(controller, backgroundRef);

		// ~160 before `$state.raw`: 16 rendered markdown blocks x 10 deltas, all
		// of it yielding byte-identical HTML for a session with no DOM on screen.
		expect(calls).toBe(0);
	});

	it("costs the selected session the same per delta however long its transcript is", async () => {
		const short = streamTen(await mounted(8), selectedRef);
		parses.mockClear();
		const long = streamTen(await mounted(24), selectedRef);

		// The invariant here is not zero -- the tail block really did change --
		// but constancy: cost tracks the delta, not the transcript behind it.
		// Assert the nonzero separately, or a renderer that stopped re-parsing
		// the tail entirely would satisfy the equality and pass green.
		expect(short).toBeGreaterThan(0);
		expect(long).toBe(short);
	});
});
