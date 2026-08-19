/**
 * What the session list costs per SSE event, counted rather than timed
 * (OW-jineli).
 *
 * The sidebar sort used to read `view.state.summaries` straight out of a
 * derived, so it was invalidated by every `publish()` -- which is every
 * streaming token, for every session -- even though nothing in an `upsert`
 * touches `summaries` and `reduceServerEvent` carries the same array reference
 * through. At the ~973 sessions D9 measured on disk, that is a full sort of the
 * corpus per token, `Date.parse` twice per comparison.
 *
 * Counts, not milliseconds: "the token re-sorted the corpus" is a yes/no, while
 * a wall-clock threshold is a coin toss on a loaded machine. `recency` is the
 * comparator's whole body, so it is what the spy wraps.
 */

import { render } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionKey, type BackendId, type ServerEvent, type SessionRef, type SessionSummary } from "$shared/protocol.ts";

const { compares } = vi.hoisted(() => ({ compares: vi.fn() }));

// `importOriginal`, so the sort under test orders by the real key and the only
// change is that every comparison is counted.
vi.mock("./time.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./time.ts")>();
	return {
		...actual,
		recency(...args: Parameters<typeof actual.recency>) {
			compares(...args);
			return actual.recency(...args);
		},
	};
});

import App from "./App.svelte";
import type { AgentpaneController, ControllerView } from "./controller.ts";
import { assistant } from "./render/samples.ts";
import { initialClientState, reduceServerEvent, type ClientState } from "./session-state.ts";

/** Enough rows that a sort is unmistakably a sort and not one stray comparison. */
const SESSIONS = 8;

const refs: SessionRef[] = Array.from({ length: SESSIONS }, (_, i) => ({
	backend: "pi",
	id: `session-${i}`,
}));
const selectedRef = refs[0]!;
const backgroundRef = refs[1]!;

/**
 * A controller that publishes the way `controller.ts`'s `publish()` does: a
 * fresh view object, then every listener. `App.test.ts`'s `FakeController` hands
 * back the same object (OW-42), which would make the count zero for the wrong
 * reason -- what is under test *is* what a publish invalidates.
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

	/**
	 * What a `sessions-changed` event actually causes: the reducer only asks for
	 * a refresh, and the refresh publishes a list read back off the server -- a
	 * genuinely new array, even where its contents are unchanged.
	 */
	relist(): void {
		flushSync(() =>
			this.publish({
				state: {
					...this.current.state,
					summaries: this.current.state.summaries.map((summary) => ({ ...summary })),
				},
			}),
		);
	}

	async start() {}
	dispose() {}
	setDraft() {}
	async create(_cwd: string, _backend: BackendId) {}
	async preview(_ref: SessionRef) {}
	async select(_ref: SessionRef) {}
	async submit() {}
	async abort() {}
	async compact() {}
	async refreshSessions() {}
	async refreshPreview() {}
	clearError() {}
}

function summary(ref: SessionRef, index: number): SessionSummary {
	return {
		ref,
		cwd: "/work/project",
		preview: ref.id,
		createdAt: null,
		// Distinct, so the sort has real work rather than a stable no-op.
		updatedAt: new Date(Date.UTC(2026, 5, 1) + index * 1000).toISOString(),
		status: "attached",
		isStreaming: false,
	};
}

function state(): ClientState {
	const session = (ref: SessionRef) => ({
		ref,
		messages: [],
		isStreaming: false,
		seq: 1,
		error: null,
		requests: [],
	});
	return {
		...initialClientState(),
		summaries: refs.map((ref, index) => summary(ref, index)),
		selected: selectedRef,
		sessions: Object.fromEntries(refs.map((ref) => [sessionKey(ref), session(ref)])),
	};
}

async function mounted(): Promise<PublishingController> {
	const controller = new PublishingController({
		state: state(),
		draft: "",
		connection: "connected",
		busy: "idle",
		error: null,
		preview: null,
	});
	render(App, { props: { controller } });
	await tick();
	flushSync();
	return controller;
}

/** Ten text deltas into `ref`'s tail message, the shape one streamed turn has. */
function streamTen(controller: PublishingController, ref: SessionRef): void {
	const index = controller.getView().state.sessions[sessionKey(ref)]!.messages.length;
	const base = assistant([], "pending");
	let seq = 1;
	controller.deliver({ type: "upsert", session: ref, seq: (seq += 1), index, message: base });
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
}

describe("session-list sort cost (OW-jineli)", () => {
	beforeEach(() => {
		compares.mockClear();
	});

	it("does not re-sort the session list for a streaming token", async () => {
		const controller = await mounted();
		compares.mockClear(); // discard the sort the first render owes

		streamTen(controller, selectedRef);
		streamTen(controller, backgroundRef);

		// 308 before the memo: a full sort of the list per delta -- 14 calls, the
		// same as one relist below -- on the session on screen and equally on the
		// one that is not.
		expect(compares).toHaveBeenCalledTimes(0);
	});

	it("still re-sorts when the list itself is replaced", async () => {
		const controller = await mounted();
		compares.mockClear();

		controller.relist();

		expect(compares.mock.calls.length).toBeGreaterThan(0);
	});
});
