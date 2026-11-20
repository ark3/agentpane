/**
 * One offline proof of the client/server contract. The app's connection
 * entry point, the manager, the broadcaster and the client's event reducer
 * are all real; only the agent process and session store are replaced with
 * deterministic fakes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { type ServerEvent, type SessionRef, sessionKey } from "../../shared/protocol.ts";
import { initialClientState, reduceServerEvent, viewOf, type ClientState } from "../../client/session-state.ts";
import { type App, createApp } from "./app.ts";
import type { AppDeps } from "./deps.ts";
import {
	assistantMessage,
	FakeAdapterFactory,
	FakeSessionIndex,
	storedSession,
	userMessage,
} from "./testing/fakes.ts";
import { TEST_API_TOKEN } from "./testing/app.ts";
import { TestSocket } from "./testing/socket-client.ts";

const WORKSPACE = process.cwd();

let app: App | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

function createOfflineApp(adapters: AppDeps["adapters"], index = new FakeSessionIndex()): App {
	return createApp({
		index,
		adapters,
		apiToken: TEST_API_TOKEN,
		newId: () => "offline-virtual-id",
		now: () => "2026-08-11T00:00:00.000Z",
	});
}

/** Apply exactly the events the client receives. */
function reduceEvents(selected: SessionRef, events: readonly ServerEvent[]): ClientState {
	let state: ClientState = { ...initialClientState(), selected };
	for (const event of events) {
		const reduced = reduceServerEvent(state, event);
		expect(reduced.recover).toEqual([]);
		state = reduced.state;
	}
	return state;
}

function transcript(state: ClientState, ref: SessionRef) {
	return viewOf(state, ref)?.messages;
}

describe("offline vertical slice", () => {
	it("drives a virtual Codex session from create through abort with its events reduced by the client", async () => {
		const codex = new FakeAdapterFactory({
			onSubmit(adapter, text) {
				adapter.append(userMessage(text));
				adapter.setStreaming(true);
				adapter.streamToken("off");
				adapter.streamToken("line");
			},
		});
		app = createOfflineApp({ codex });
		const events = await new TestSocket(app).hello();

		const created = (await events.ok("sessions/create", { cwd: WORKSPACE, backend: "codex" })).session;
		expect(created.ref).toEqual({ backend: "codex", id: "virtual:offline-virtual-id" });
		expect(events.typed("snapshot")).toHaveLength(1);

		expect(await events.ok("sessions/prompt", { handle: created.handle, text: "hello" })).toEqual({ disposition: "started" });
		expect([events.isStreaming(created.ref), events.transcript(created.ref).length]).toEqual([true, 2]);

		expect(await events.ok("sessions/abort", { handle: created.handle })).toEqual({ queued: [] });
		expect(events.typed("status").some((event) => !event.isStreaming)).toBe(true);

		const state = reduceEvents(created.ref, events.events);
		expect(transcript(state, created.ref)).toEqual([userMessage("hello"), assistantMessage("offline")]);
		expect(viewOf(state, created.ref)?.isStreaming).toBe(false);
		expect(codex.created).toHaveLength(1);
		expect(codex.created[0]?.aborts).toBe(1);
	});

	it("follows a materialised id by the snapshot under the handle, with no renamed on the wire", async () => {
		const materialised: SessionRef = { backend: "codex", id: "thread-offline-proof" };
		const codex = new FakeAdapterFactory({
			materialiseOnSubmit: materialised.id,
			onSubmit(adapter, text) {
				adapter.append(userMessage(text));
				adapter.append(assistantMessage("saved"));
			},
		});
		app = createOfflineApp({ codex });
		const events = await new TestSocket(app).hello();

		const created = (await events.ok("sessions/create", { cwd: WORKSPACE, backend: "codex" })).session;
		const { handle } = events.typed("snapshot")[0]!;
		expect(handle).toBe(created.handle);

		await events.ok("sessions/prompt", { handle, text: "materialise" });
		expect(events.typed("snapshot").some((event) => sessionKey(event.session) === sessionKey(materialised))).toBe(true);

		// The first event naming the new ref is a snapshot under the handle the
		// session had all along, and nothing announces the rename beside it (D24).
		const movedAt = events.events.findIndex((event) => event.type !== "sessions-changed" && sessionKey(event.session) === sessionKey(materialised));
		expect(events.events[movedAt]).toMatchObject({ type: "snapshot", session: materialised, handle });
		expect(events.events.map((event) => event.type)).not.toContain("renamed");

		const state = reduceEvents(created.ref, events.events);
		expect(state.selected).toEqual(materialised);
		expect(viewOf(state, created.ref)).toBeUndefined();
		expect(Object.keys(state.sessions)).toEqual([handle]);
		expect(transcript(state, materialised)).toEqual([
			userMessage("materialise"),
			assistantMessage("saved"),
		]);
		expect(viewOf(state, materialised)?.isStreaming).toBe(false);
	});

	it("leaves a browser that did not fork on the parent it was reading (OW-suhoto)", async () => {
		// Pi is the only backend whose own ref moves on fork, so it is the only one
		// that reaches `#forkOnto` at all. The parent is detached, not
		// renamed: it is still on disk and still listed, so a second browser that
		// was reading it must keep its selection. Its live view goes with the
		// parent's handle (D26), and the pane falls to the parent's preview.
		const parent: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/parent.jsonl" };
		const fork: SessionRef = { backend: "pi", id: `${parent.id}#fork-e1` };
		const pi = new FakeAdapterFactory({
			onSubmit(adapter, text) {
				adapter.append(userMessage(text));
				adapter.append(assistantMessage("parent reply"));
			},
		});
		app = createOfflineApp({ pi }, new FakeSessionIndex([storedSession(parent, WORKSPACE)]));
		// The browser that does NOT fork: it is on its own socket and its
		// selection is the parent throughout.
		const onlooker = await new TestSocket(app).hello();
		const forker = await new TestSocket(app).hello();

		const { session } = await forker.ok("sessions/attach", { ref: parent });
		expect(onlooker.typed("snapshot")).toHaveLength(1);
		await forker.ok("sessions/prompt", { handle: session.handle, text: "hello" });
		expect(onlooker.transcript(parent)).toHaveLength(2);

		const forked = await forker.ok("sessions/fork", { handle: session.handle, entryId: "e1" });
		expect(forked.ref).toEqual(fork);
		// The list invalidation the fork emits.
		expect(onlooker.typed("sessions-changed").length).toBeGreaterThanOrEqual(1);

		const state = reduceEvents(parent, onlooker.events);
		expect(state.selected).toEqual(parent);
		expect(viewOf(state, parent)).toBeUndefined();
		expect(viewOf(state, fork)).toBeUndefined();
		// And the reason it holds: nothing was renamed, a second conversation was
		// created under a handle of its own, so no event re-keys anyone.
		expect(onlooker.events.map((event) => event.type)).not.toContain("renamed");
	});
});
