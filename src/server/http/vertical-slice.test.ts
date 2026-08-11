/**
 * One offline proof of the browser/server contract.  The HTTP app, manager,
 * broadcaster, SSE framing and client event reducer are all real; only the
 * agent process and session store are replaced with deterministic fakes.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	type AttachSessionResponse,
	type CreateSessionResponse,
	ROUTES,
	type ServerEvent,
	type SessionRef,
	sessionKey,
} from "../../shared/protocol.ts";
import { initialClientState, reduceServerEvent, type ClientState } from "../../client/session-state.ts";
import { type App, createApp } from "./app.ts";
import {
	assistantMessage,
	FakeAdapterFactory,
	FakeSessionIndex,
	userMessage,
} from "./testing/fakes.ts";
import { SseTestClient } from "./testing/sse-client.ts";

const WORKSPACE = "/workspace/offline-proof";

let app: App | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

function createOfflineApp(codex: FakeAdapterFactory): App {
	return createApp({
		index: new FakeSessionIndex(),
		adapters: { codex },
		newId: () => "offline-virtual-id",
		now: () => "2026-08-11T00:00:00.000Z",
	});
}

function request(path: string, init?: RequestInit): Promise<Response> {
	return app!.fetch(new Request(`http://127.0.0.1${path}`, init));
}

function post(path: string, body: unknown = {}): Promise<Response> {
	return request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function openEvents(): Promise<SseTestClient> {
	const response = await request(ROUTES.events);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	return new SseTestClient(response);
}

/** Apply exactly the decoded SSE payloads the browser receives. */
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
	return state.sessions[sessionKey(ref)]?.messages;
}

describe("offline vertical slice", () => {
	it("drives a virtual Codex session from create through abort with SSE reduced by the client", async () => {
		const codex = new FakeAdapterFactory({
			onSubmit(adapter, text) {
				adapter.append(userMessage(text));
				adapter.setStreaming(true);
				adapter.streamToken("off");
				adapter.streamToken("line");
			},
		});
		app = createOfflineApp(codex);
		const events = await openEvents();

		const created = (await (await post(ROUTES.sessions, { cwd: WORKSPACE, backend: "codex" })).json()) as CreateSessionResponse;
		expect(created.ref).toEqual({ backend: "codex", id: "virtual:offline-virtual-id" });

		const attached = (await (await request(ROUTES.session(created.ref))).json()) as AttachSessionResponse;
		expect(attached.session.ref).toEqual(created.ref);
		await events.until(() => events.typed("snapshot").length === 1, "the attach snapshot");

		expect((await post(ROUTES.prompt(created.ref), { text: "hello" })).status).toBe(202);
		await events.until(
			() => events.isStreaming(created.ref) && events.transcript(created.ref).length === 2,
			"the streaming turn",
		);

		expect((await post(ROUTES.abort(created.ref))).status).toBe(204);
		await events.until(
			() => events.typed("status").some((event) => !event.isStreaming),
			"the aborted streaming state",
		);

		const state = reduceEvents(created.ref, events.events);
		expect(transcript(state, created.ref)).toEqual([userMessage("hello"), assistantMessage("offline")]);
		expect(state.sessions[sessionKey(created.ref)]?.isStreaming).toBe(false);
		expect(codex.created).toHaveLength(1);
		expect(codex.created[0]?.aborts).toBe(1);
		await events.close();
	});

	it("follows a materialised id when renamed is immediately followed by a snapshot", async () => {
		const materialised: SessionRef = { backend: "codex", id: "thread-offline-proof" };
		const codex = new FakeAdapterFactory({
			materialiseOnSubmit: materialised.id,
			onSubmit(adapter, text) {
				adapter.append(userMessage(text));
				adapter.append(assistantMessage("saved"));
			},
		});
		app = createOfflineApp(codex);
		const events = await openEvents();

		const created = (await (await post(ROUTES.sessions, { cwd: WORKSPACE, backend: "codex" })).json()) as CreateSessionResponse;
		await request(ROUTES.session(created.ref));
		await events.until(() => events.typed("snapshot").length === 1, "the virtual attach snapshot");

		expect((await post(ROUTES.prompt(created.ref), { text: "materialise" })).status).toBe(202);
		await events.until(
			() => events.typed("snapshot").some((event) => sessionKey(event.session) === sessionKey(materialised)),
			"the materialised snapshot",
		);

		const renamedAt = events.events.findIndex((event) => event.type === "renamed");
		expect(events.events.slice(renamedAt, renamedAt + 2).map((event) => event.type)).toEqual([
			"renamed",
			"snapshot",
		]);
		expect(events.typed("renamed")[0]).toMatchObject({ from: created.ref, session: materialised });

		const state = reduceEvents(created.ref, events.events);
		expect(state.selected).toEqual(materialised);
		expect(state.sessions[sessionKey(created.ref)]).toBeUndefined();
		expect(transcript(state, materialised)).toEqual([
			userMessage("materialise"),
			assistantMessage("saved"),
		]);
		expect(state.sessions[sessionKey(materialised)]?.isStreaming).toBe(false);
		await events.close();
	});
});
