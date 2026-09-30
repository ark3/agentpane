/**
 * Process-table edges that are awkward to provoke through HTTP: concurrent
 * attaches, a spawn that fails, and the bookkeeping that must not outlive a
 * session.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type ServerEvent, type SessionRef, sessionKey } from "../../shared/protocol.ts";
import { ClaudeAdapterFactory } from "../adapters/claude/adapter.ts";
import { FakeClaudeProcess } from "../adapters/claude/test-support.ts";
import { CodexAdapterFactory } from "../adapters/codex/adapter.ts";
import type { CodexProcess } from "../adapters/codex/process.ts";
import { FakeCodexProcess } from "../adapters/codex/test-support.ts";
import { Broadcaster } from "./broadcaster.ts";
import { SessionManager, UnknownBackendError, UnknownSessionError } from "./session-manager.ts";
import type { SessionIndex } from "./deps.ts";
import {
	deferred,
	type FakeAdapter,
	FakeAdapterFactory,
	type FakeAdapterOptions,
	FakeSessionIndex,
	FakeSharedChild,
	storedSession,
	userMessage,
} from "./testing/fakes.ts";

const REF: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/a.jsonl" };
const WORKSPACE = "/home/u/src/agentpane";

let index: FakeSessionIndex;
let pi: FakeAdapterFactory;
let broadcaster: Broadcaster;
let sessions: SessionManager;

beforeEach(() => {
	index = new FakeSessionIndex([storedSession(REF, WORKSPACE)]);
	pi = new FakeAdapterFactory();
	broadcaster = new Broadcaster();
	sessions = new SessionManager({ index, adapters: { pi } }, broadcaster);
});

/** Every event `broadcaster` sends from here on, as a client receives it. */
function broadcastEvents(): ServerEvent[] {
	const events: ServerEvent[] = [];
	broadcaster.addClient((chunk) => {
		for (const line of chunk.split("\n")) {
			if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as ServerEvent);
		}
	});
	return events;
}

/** The events among `events` that name `ref`. */
function naming(ref: SessionRef, events: ServerEvent[]): ServerEvent[] {
	return events.filter((event) => "session" in event && sessionKey(event.session) === sessionKey(ref));
}

/** Let queued microtasks drain, so `start()` has actually been entered. */
async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Hold `adapter.dispose()` open until the returned release is called. */
function holdDispose(adapter: FakeAdapter): () => void {
	const held = deferred();
	const dispose = adapter.dispose.bind(adapter);
	adapter.dispose = async () => {
		await held.promise;
		await dispose();
	};
	return () => held.resolve();
}

describe("attach", () => {
	it("spawns once even when two attaches race", async () => {
		const [a, b] = await Promise.all([sessions.attach(REF), sessions.attach(REF)]);
		expect(a).toBe(b);
		expect(pi.created).toHaveLength(1);
	});

	it("refuses a session with no recorded workspace rather than jailing the wrong tree (D7)", async () => {
		index.summaries = [{ ...storedSession(REF, WORKSPACE), cwd: null }];
		await expect(sessions.attach(REF)).rejects.toThrow(/workspace/);
		expect(pi.created).toHaveLength(0);
	});

	it("leaves nothing half-registered when the spawn fails, and a retry still works", async () => {
		const flaky = new FakeAdapterFactory({ failStart: "sbox: no git root" });
		sessions = new SessionManager({ index, adapters: { pi: flaky } }, broadcaster);

		await expect(sessions.attach(REF)).rejects.toThrow("sbox: no git root");
		expect(sessions.isAttached(REF)).toBe(false);
		expect((await sessions.list()).find((s) => sessionKey(s.ref) === sessionKey(REF))?.status).toBe(
			"detached",
		);

		// A failed adapter must not stay subscribed: its events would be
		// broadcast for a session that is not running.
		const frames: string[] = [];
		broadcaster.addClient((chunk) => frames.push(chunk));
		flaky.created[0]?.append(userMessage("ghost"));
		expect(frames.filter((frame) => frame.startsWith("data: "))).toEqual([]);

		sessions = new SessionManager({ index, adapters: { pi } }, broadcaster);
		await expect(sessions.attach(REF)).resolves.toBeDefined();
	});

	it("leaves no live session when Claude reports an asynchronous spawn failure", async () => {
		const ref: SessionRef = { backend: "claude", id: "stored-claude-id" };
		index = new FakeSessionIndex([storedSession(ref, WORKSPACE)]);
		const proc = new FakeClaudeProcess(false);
		const claude = new ClaudeAdapterFactory({
			spawn: () => {
				queueMicrotask(() =>
					proc.exit(null, null, new Error("Failed to spawn Claude Code (direnv): ENOENT")),
				);
				return proc;
			},
			readStoreEntries: async () => [],
		});
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);

		await expect(sessions.attach(ref)).rejects.toThrow(
			"Failed to spawn Claude Code (direnv): ENOENT",
		);
		expect(sessions.isAttached(ref)).toBe(false);
		expect(sessions.liveRefs()).toEqual([]);
	});

	it("rejects a backend with no factory", async () => {
		await expect(sessions.attach({ backend: "codex", id: "x" })).rejects.toBeInstanceOf(
			UnknownBackendError,
		);
		expect(() => sessions.createVirtual(WORKSPACE, "codex")).toThrow(UnknownBackendError);
	});

	it("rejects a session no store knows about", async () => {
		await expect(sessions.attach({ backend: "pi", id: "/nope" })).rejects.toBeInstanceOf(
			UnknownSessionError,
		);
	});

	it("uses the index's canonical ref while keeping the requested ref as an alias", async () => {
		const requested: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/../ws/a.jsonl",
		};
		const canonical: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/a.jsonl",
		};
		const summary = storedSession(canonical, WORKSPACE);
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async (ref) => (sessionKey(ref) === sessionKey(requested) ? summary : null),
			preview: async () => [],
		};
		sessions = new SessionManager(
			{ index: canonicalizingIndex, adapters: { pi } },
			broadcaster,
		);

		const adapter = await sessions.attach(requested);

		expect(pi.createdFor).toEqual([canonical]);
		expect(pi.created[0]?.startOptions).toEqual({ cwd: WORKSPACE, resumeId: canonical.id });
		expect(sessions.canonicalRef(requested)).toEqual(canonical);
		expect(sessions.adapterFor(requested)).toBe(adapter);
		expect(sessions.summaryOf(requested)?.ref).toEqual(canonical);
	});

	it("removes the canonical table entry and requested alias when startup fails", async () => {
		const requested: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/subdir/../a.jsonl",
		};
		const summary = storedSession(REF, WORKSPACE);
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async () => summary,
			preview: async () => [],
		};
		const failing = new FakeAdapterFactory({ failStart: "startup failed" });
		sessions = new SessionManager(
			{ index: canonicalizingIndex, adapters: { pi: failing } },
			broadcaster,
		);

		await expect(sessions.attach(requested)).rejects.toThrow("startup failed");

		expect(failing.createdFor).toEqual([REF]);
		expect(sessions.canonicalRef(requested)).toEqual(requested);
		expect(sessions.adapterFor(REF)).toBeUndefined();
		expect(sessions.liveRefs()).toEqual([]);
	});

	it("reuses an attached canonical session reached later through another spelling", async () => {
		const canonical: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/a.jsonl",
		};
		const alias: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/../ws/a.jsonl",
		};
		const summary = storedSession(canonical, WORKSPACE);
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async () => summary,
			preview: async () => [],
		};
		sessions = new SessionManager(
			{ index: canonicalizingIndex, adapters: { pi } },
			broadcaster,
		);

		const first = await sessions.attach(canonical);
		const throughAlias = await sessions.attach(alias);

		expect(throughAlias).toBe(first);
		expect(pi.created).toHaveLength(1);
		expect(sessions.canonicalRef(alias)).toEqual(canonical);
		expect(sessions.liveRefs()).toEqual([canonical]);
		expect(sessions.adapterFor(canonical)).toBe(first);
	});

	it("collapses concurrent distinct aliases after the index canonicalizes them", async () => {
		const canonical: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/a.jsonl",
		};
		const aliasA: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/../ws/a.jsonl",
		};
		const aliasB: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/other/../ws/a.jsonl",
		};
		const summary = storedSession(canonical, WORKSPACE);
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async () => summary,
			preview: async () => [],
		};
		sessions = new SessionManager(
			{ index: canonicalizingIndex, adapters: { pi } },
			broadcaster,
		);

		const [first, second] = await Promise.all([
			sessions.attach(aliasA),
			sessions.attach(aliasB),
		]);

		expect(second).toBe(first);
		expect(pi.created).toHaveLength(1);
		expect(sessions.canonicalRef(aliasA)).toEqual(canonical);
		expect(sessions.canonicalRef(aliasB)).toEqual(canonical);
		expect(sessions.liveRefs()).toEqual([canonical]);
		expect(sessions.adapterFor(canonical)).toBe(first);
	});

	it("a failed canonical winner leaves no state owned by either concurrent alias", async () => {
		const canonical: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/a.jsonl",
		};
		const aliasA: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/../ws/a.jsonl",
		};
		const aliasB: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/other/../ws/a.jsonl",
		};
		const summary = storedSession(canonical, WORKSPACE);
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async () => summary,
			preview: async () => [],
		};
		const failing = new FakeAdapterFactory({ failStart: "canonical startup failed" });
		sessions = new SessionManager(
			{ index: canonicalizingIndex, adapters: { pi: failing } },
			broadcaster,
		);

		const results = await Promise.allSettled([
			sessions.attach(aliasA),
			sessions.attach(aliasB),
		]);

		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
		expect(failing.created).toHaveLength(1);
		expect(sessions.canonicalRef(aliasA)).toEqual(aliasA);
		expect(sessions.canonicalRef(aliasB)).toEqual(aliasB);
		expect(sessions.adapterFor(canonical)).toBeUndefined();
		expect(sessions.liveRefs()).toEqual([]);
	});
});

describe("an adapter that renames itself (the Pi contract)", () => {
	// `PiAdapter.ref` is not stable at construction: Pi's session id IS its JSONL
	// path (D9), which Pi names from start()'s get_state, and a backend that has
	// named nothing by the end of attach names it at the first prompt instead. The
	// adapter announces each move through `onRefChanged` and the manager writes
	// the new id onto the container as one more name (D24); these are that
	// contract.
	const REAL = "/home/u/.pi/agent/sessions/materialised.jsonl";

	it("adopts the id the adapter took during start()", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);

		await sessions.attach(REF);

		expect(sessions.canonicalRef(REF)).toEqual({ backend: "pi", id: REAL });
		expect(sessions.liveRefs()).toEqual([{ backend: "pi", id: REAL }]);
		// The summary the attach route hands back is the browser's other way of
		// learning the new id, so it must not still carry the index's stale one.
		expect(sessions.summaryOf(REF)?.ref).toEqual({ backend: "pi", id: REAL });
		expect(sessions.summaryOf(REF)?.preview).toBe("hello");
		// One session, listed once -- not once under each id.
		const listed = await sessions.list();
		expect(listed.filter((s) => s.status === "attached")).toHaveLength(1);
	});

	it("adopts the id a virtual session takes on its first prompt when attach named none (D9)", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnSubmit: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi");

		await sessions.attach(virtualRef);
		expect(sessions.canonicalRef(virtualRef)).toEqual(virtualRef);

		await sessions.submit(virtualRef, "first");

		const real: SessionRef = { backend: "pi", id: REAL };
		expect(sessions.canonicalRef(virtualRef)).toEqual(real);
		expect(sessions.liveRefs()).toEqual([real]);
		expect(sessions.adapterFor(real)).toBeDefined();
		// A session listed under a `virtual:` id it no longer has is a session the
		// browser can never find on disk again.
		const listed = await sessions.list();
		expect(listed.map((s) => s.ref.id)).not.toContain(virtualRef.id);
	});

	it("keeps the pre-rename id working for a client that still holds it", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnSubmit: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi");
		await sessions.attach(virtualRef);
		await sessions.submit(virtualRef, "first");

		// The browser POSTed against the id it created and has not refetched yet.
		await expect(sessions.submit(virtualRef, "second")).resolves.toBeUndefined();
		expect(renaming.forRef(virtualRef)?.prompts.map((p) => p.text)).toEqual(["first", "second"]);
		expect(renaming.created).toHaveLength(1);
		expect(sessions.isAttached(virtualRef)).toBe(true);
	});

	it("closes a renamed session under either id", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		await sessions.attach(REF);

		await sessions.close(REF);

		expect(sessions.liveRefs()).toEqual([]);
		expect(sessions.canonicalRef(REF)).toEqual(REF);
		expect(renaming.created[0]?.disposed).toBe(true);
	});

	it("names the container by the session Claude Code's init names after submit() resolved (OW-hikefi)", async () => {
		// `init` arrives with the turn, after `submit()` admitted it, so no point
		// the manager could poll at follows it.
		const proc = new FakeClaudeProcess();
		const claude = new ClaudeAdapterFactory({
			spawn: () => proc,
			readStoreEntries: async () => [],
			newSessionId: () => "minted",
		});
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "claude");
		const adapter = await sessions.attach(virtualRef);
		const minted: SessionRef = { backend: "claude", id: "minted" };
		expect(sessions.canonicalRef(virtualRef)).toEqual(minted);
		const handle = sessions.summaryOf(minted)?.handle;
		const events = broadcastEvents();

		await sessions.submit(minted, "hi");
		proc.emit({ type: "system", subtype: "init", session_id: "cli-chosen" });

		const chosen: SessionRef = { backend: "claude", id: "cli-chosen" };
		expect(naming(chosen, events)).toEqual([expect.objectContaining({ type: "snapshot", handle })]);
		expect(sessions.liveRefs()).toEqual([chosen]);
		expect(sessions.adapterFor(chosen)).toBe(adapter);
		expect(sessions.adapterFor(minted)).toBe(adapter);
		expect(sessions.adapterFor(virtualRef)).toBe(adapter);
	});

	describe("a rename announced inside start()", () => {
		// All three adapters rename there. The container is keyed by its handle
		// and holds the startup itself, so the new id is written as a name at
		// once and reaches that startup; only the wire waits for the adapter to
		// be published (D24, OW-suyinu, OW-mofuho).
		const real: SessionRef = { backend: "pi", id: REAL };

		/** A factory whose adapters rename during `start()`, then do `after` before it settles. */
		function renamingInsideStart(after: (adapter: FakeAdapter) => Promise<void>): FakeAdapterFactory {
			const factory = new FakeAdapterFactory();
			const create = factory.create.bind(factory);
			factory.create = (ref) => {
				const adapter = create(ref);
				const start = adapter.start.bind(adapter);
				adapter.start = async (opts) => {
					await start(opts);
					adapter.materialiseAs(REAL);
					await after(adapter);
				};
				return adapter;
			};
			return factory;
		}

		/** Attach REF through a factory that renames inside `start()`, parked just after the rename. */
		async function attachParkedAfterRename(during?: (adapter: FakeAdapter) => void) {
			const gate = deferred();
			const renamedInside = deferred();
			const factory = renamingInsideStart(async (adapter) => {
				during?.(adapter);
				renamedInside.resolve();
				await gate.promise;
			});
			sessions = new SessionManager({ index, adapters: { pi: factory } }, broadcaster);
			const wire = broadcastEvents();
			const attaching = sessions.attach(REF);
			await renamedInside.promise;
			return { factory, wire, attaching, release: () => gate.resolve() };
		}

		it("writes the new name at once, and an attach under it joins the one startup", async () => {
			const { factory, wire, attaching, release } = await attachParkedAfterRename();

			expect(sessions.canonicalRef(REF)).toEqual(real);
			const handle = sessions.summaryOf(REF)?.handle;
			expect(sessions.summaryOf(real)?.handle).toBe(handle);
			const joining = sessions.attach(real);
			// Held for the publish: a start that still fails must leave nothing.
			expect(wire).toEqual([]);

			release();
			expect(await joining).toBe(await attaching);
			expect(factory.created).toHaveLength(1);
			// Said once, by the attach, and under the handle.
			expect(wire.map((event) => event.type)).toEqual(["sessions-changed", "snapshot"]);
			expect(wire[1]).toMatchObject({ session: real, handle });
			expect(sessions.liveRefs()).toEqual([real]);
		});

		it("stops the one startup when closed under the new name", async () => {
			const { factory, wire, attaching, release } = await attachParkedAfterRename();

			await sessions.close(real);
			release();

			await expect(attaching).rejects.toBeInstanceOf(UnknownSessionError);
			expect(factory.created).toHaveLength(1);
			expect(factory.created[0]?.disposed).toBe(true);
			// Nothing but the close's `ended`, under a handle no snapshot ever gave
			// a client, so none holds a view for it to end (D26).
			expect(naming(real, wire).map((event) => event.type)).toEqual(["ended"]);
			expect(sessions.liveRefs()).toEqual([]);
			expect(sessions.summaryOf(REF)).toBeNull();
			expect(sessions.summaryOf(real)).toBeNull();
		});

		it("sends what the adapter emits during start under the new ref", async () => {
			const { wire, release, attaching } = await attachParkedAfterRename((adapter) => adapter.append(userMessage("hello")));

			expect(wire).toEqual([expect.objectContaining({ type: "upsert", session: real, index: 0 })]);
			release();
			await attaching;
			expect(naming(REF, wire)).toEqual([]);
		});

		it("leaves no rename, no alias and nothing on the wire behind when start() then fails", async () => {
			const factory = renamingInsideStart(async () => {
				throw new Error("get_messages failed");
			});
			sessions = new SessionManager({ index, adapters: { pi: factory } }, broadcaster);
			const wire = broadcastEvents();

			await expect(sessions.attach(REF)).rejects.toThrow("get_messages failed");

			expect(wire).toEqual([]);
			expect(sessions.canonicalRef(REF)).toEqual(REF);
			expect(sessions.summaryOf(real)).toBeNull();
			expect(sessions.liveRefs()).toEqual([]);
			// A name left on REF's container would hide the stored session from the list.
			expect((await sessions.list()).map((summary) => summary.ref)).toEqual([REF]);
		});

		it("undoes the rename on a virtual container that outlives a failed start", async () => {
			// The container stays for a retry, which must not resume an id the
			// failed adapter announced and never stored.
			const factory = renamingInsideStart(async () => {
				throw new Error("get_messages failed");
			});
			sessions = new SessionManager({ index, adapters: { pi: factory } }, broadcaster);
			const virtualRef = sessions.createVirtual(WORKSPACE, "pi");
			const handle = sessions.summaryOf(virtualRef)?.handle;

			await expect(sessions.attach(virtualRef)).rejects.toThrow("get_messages failed");

			expect(sessions.summaryOf(virtualRef)).toEqual(expect.objectContaining({ ref: virtualRef, handle, status: "virtual" }));
			expect(sessions.summaryOf(real)).toBeNull();
		});

		it("holds back an attach under either name while a start that failed after the rename reaps its adapter (OW-yufazo)", async () => {
			let releaseDispose: (() => void) | undefined;
			const reaping = deferred();
			const factory = renamingInsideStart(async (adapter) => {
				if (releaseDispose) return;
				releaseDispose = holdDispose(adapter);
				reaping.resolve();
				throw new Error("get_messages failed");
			});
			index.summaries = [storedSession(REF, WORKSPACE), storedSession(real, WORKSPACE)];
			sessions = new SessionManager({ index, adapters: { pi: factory } }, broadcaster);

			const failing = sessions.attach(REF);
			await reaping.promise;
			await settle();
			const closing = sessions.close(real);
			const throughReal = sessions.attach(real);
			const throughRef = sessions.attach(REF);
			await settle();

			expect(factory.created).toHaveLength(1);

			releaseDispose?.();
			await closing;
			await expect(failing).rejects.toThrow("get_messages failed");
			const replacement = await throughReal;
			expect(await throughRef).toBe(replacement);
			expect(factory.created).toEqual([expect.anything(), replacement]);
			expect(factory.created[0]?.disposals).toBe(1);
			expect(sessions.liveRefs()).toEqual([real]);
		});

		it("resumes the stored session, not the id the failed start announced, for an attach held back by a close during its reaping (OW-yufazo)", async () => {
			// The index has never heard of `real`: the failed start announced it and stored nothing.
			let releaseDispose: (() => void) | undefined;
			const reaping = deferred();
			const factory = renamingInsideStart(async (adapter) => {
				if (releaseDispose) return;
				releaseDispose = holdDispose(adapter);
				reaping.resolve();
				throw new Error("get_messages failed");
			});
			sessions = new SessionManager({ index, adapters: { pi: factory } }, broadcaster);

			const failing = sessions.attach(REF);
			await reaping.promise;
			await settle();
			const closing = sessions.close(real);
			const throughReal = sessions.attach(real);
			releaseDispose?.();
			await closing;

			await expect(failing).rejects.toThrow("get_messages failed");
			expect(await throughReal).toBe(factory.created[1]);
			expect(factory.created[1]?.startOptions).toEqual({ cwd: WORKSPACE, resumeId: REF.id });
		});

		it("holds back an attach under the name a virtual session's failed start took, once closed under its own during the reaping (OW-kamave)", async () => {
			// The failure takes `real` back off the virtual container, which stays
			// in the table; the startup still answers to it until it is retired.
			let releaseDispose: (() => void) | undefined;
			const reaping = deferred();
			const factory = renamingInsideStart(async (adapter) => {
				if (releaseDispose) return;
				releaseDispose = holdDispose(adapter);
				reaping.resolve();
				throw new Error("get_messages failed");
			});
			index.summaries = [storedSession(REF, WORKSPACE), storedSession(real, WORKSPACE)];
			sessions = new SessionManager({ index, adapters: { pi: factory } }, broadcaster);
			const virtualRef = sessions.createVirtual(WORKSPACE, "pi");

			const failing = sessions.attach(virtualRef);
			await reaping.promise;
			await settle();
			let closed = false;
			const closing = sessions.close(virtualRef).then(() => {
				closed = true;
			});
			// How it ends is not this card's: it resumes under the virtual ref the
			// disposal carries, although `real` is in the index.
			const throughReal = Promise.allSettled([sessions.attach(real)]);
			await settle();
			await settle();

			expect(closed).toBe(false);
			expect(factory.created).toHaveLength(1);
			expect(factory.created[0]?.disposed).toBe(false);

			releaseDispose?.();
			await closing;
			await expect(failing).rejects.toThrow("get_messages failed");
			await throughReal;
			expect(factory.created).toHaveLength(1);
			expect(factory.created[0]?.disposals).toBe(1);
			expect(sessions.liveRefs()).toEqual([]);
		});
	});
});

describe("fork, which moves the live adapter's ref on Pi alone", () => {
	// The backends are asymmetric (settled live, MANUAL_TESTING.md OW-pifowo
	// / OW-22; Claude Code's fork leaves its own ref alone like Codex's,
	// OW-razoki): only Pi's adapter announces a `"fork"`, and SessionManager.fork
	// must handle every shape.
	it("moves the adapter onto the fork's container, naming the fork under nothing of the parent's, when a Pi-style fork moves the active file", async () => {
		await sessions.attach(REF);
		const parentHandle = sessions.summaryOf(REF)?.handle;
		const events = broadcastEvents();

		const forked = await sessions.fork(REF, "e1");

		// FakeAdapter's Pi fork adopts `${id}#fork-e1`; the manager returns that
		// moved ref and moves the adapter onto a container named by it.
		const moved: SessionRef = { backend: "pi", id: `${REF.id}#fork-e1` };
		expect(forked).toEqual(moved);
		expect(sessions.liveRefs()).toEqual([moved]);
		// But nothing under the parent's handle names the fork: the parent was not
		// renamed, it was left behind as a second conversation, and a new ref under
		// its handle tells every client the opposite (OW-suhoto). What goes there
		// is that the handle has ended, under the parent's own ref, and nothing
		// after it (D26).
		expect(events.filter((event) => "handle" in event && event.handle === parentHandle)).toEqual([
			{ type: "ended", session: REF, handle: parentHandle },
		]);
	});

	it("does NOT re-key when a Codex-style fork leaves the adapter's own ref unchanged", async () => {
		const codexRef: SessionRef = { backend: "codex", id: "thread-parent" };
		const codex = new FakeAdapterFactory({ forkMode: "codex" });
		index = new FakeSessionIndex([storedSession(codexRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(codexRef);
		const events = broadcastEvents();

		const forked = await sessions.fork(codexRef, "e1");

		// The returned ref is the new thread, distinct from the adapter's own ref.
		expect(forked).toEqual({ backend: "codex", id: "thread-parent#fork-e1" });
		// The parent session is still keyed by its original id -- no re-key, no rename.
		expect(sessions.canonicalRef(codexRef)).toEqual(codexRef);
		expect(sessions.liveRefs()).toEqual([codexRef]);
		expect(events.filter((event) => "session" in event && sessionKey(event.session) !== sessionKey(codexRef))).toEqual([]);
	});

	// Claude Code's shape (OW-razoki): `fork()` mints the fork's id and the
	// arguments that spawn its child, but runs nothing. The fork's store file
	// does not exist until its first turn ends (OW-japuzo), so the session index
	// cannot answer for it -- the manager has to hold that recipe until the fork
	// is attached, and hand it to the fork's own adapter.
	it("attaches a fork the session index has never heard of, from the recipe fork() returned", async () => {
		const claudeRef: SessionRef = { backend: "claude", id: "parent" };
		const claude = new FakeAdapterFactory({ forkMode: "claude" });
		index = new FakeSessionIndex([storedSession(claudeRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		const parent = await sessions.attach(claudeRef);

		const forked = await sessions.fork(claudeRef, "e1");

		expect(forked).toEqual({ backend: "claude", id: "parent#fork-e1" });
		// The parent is untouched: same ref, same live adapter.
		expect(sessions.canonicalRef(claudeRef)).toEqual(claudeRef);
		expect(sessions.adapterFor(claudeRef)).toBe(parent);

		const forkAdapter = (await sessions.attach(forked)) as FakeAdapter;

		expect(forkAdapter).not.toBe(parent);
		expect(claude.forRef(forked)?.startOptions).toEqual({
			cwd: WORKSPACE,
			forkOf: { parentId: "parent", entryId: "e1" },
		});
		expect(sessions.liveRefs().map(sessionKey).sort()).toEqual(
			[sessionKey(claudeRef), sessionKey(forked)].sort(),
		);
		// The container built from the recipe carries the recipe's workspace, or
		// the fork drops out of the sidebar the user forked it from: nothing on
		// disk carries its cwd yet, so `#ownSummary` is the only thing that can
		// answer the cwd-filtered list (D7, D9).
		expect((await sessions.list({ cwd: WORKSPACE })).map((s) => sessionKey(s.ref))).toContain(
			sessionKey(forked),
		);
	});

	it("keeps the recipe parked when the fork's start fails, so a retry starts it", async () => {
		// Replayable, unlike a handle: the recipe is the whole of what a retry
		// has left to work from, since the index cannot answer for the fork.
		const claudeRef: SessionRef = { backend: "claude", id: "parent" };
		// One options object every adapter the factory builds reads, so the
		// fork's start can fail without the parent's having failed.
		const options: FakeAdapterOptions = { forkMode: "claude" };
		const claude = new FakeAdapterFactory(options);
		index = new FakeSessionIndex([storedSession(claudeRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		await sessions.attach(claudeRef);
		const forked = await sessions.fork(claudeRef, "e1");

		options.failStart = "fork refused";
		await expect(sessions.attach(forked)).rejects.toThrow("fork refused");
		delete options.failStart;
		const retried = (await sessions.attach(forked)) as FakeAdapter;

		expect(claude.created).toHaveLength(3);
		expect(retried).toBe(claude.created[2]);
		expect(retried.startOptions).toEqual({ cwd: WORKSPACE, forkOf: { parentId: "parent", entryId: "e1" } });
	});

	it("discards the recipe for a fork the caller deleted before ever attaching it", async () => {
		const claudeRef: SessionRef = { backend: "claude", id: "parent" };
		const claude = new FakeAdapterFactory({ forkMode: "claude" });
		index = new FakeSessionIndex([storedSession(claudeRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		await sessions.attach(claudeRef);
		const forked = await sessions.fork(claudeRef, "e1");

		await sessions.close(forked);

		// DELETE then attach is reachable straight off the HTTP API. A recipe that
		// survived the close would spawn a sandboxed agent for a session the
		// caller has already thrown away.
		await expect(sessions.attach(forked)).rejects.toBeInstanceOf(UnknownSessionError);
		expect(claude.created).toHaveLength(1);
	});

	it("stops reaching the recipe once the fork has its own child, including on a spelling the rename left behind", async () => {
		const claudeRef: SessionRef = { backend: "claude", id: "parent" };
		// The CLI is authoritative about its own store, so a Claude session can
		// rename under us after `start()` -- `ClaudeAdapter` adopts the id `init`
		// reports. The client follows the snapshot under the handle and holds the
		// new ref from there.
		const claude = new FakeAdapterFactory({ forkMode: "claude", materialiseOnSubmit: "fork-real" });
		index = new FakeSessionIndex([storedSession(claudeRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		await sessions.attach(claudeRef);
		const forked = await sessions.fork(claudeRef, "e1");
		await sessions.attach(forked);
		await sessions.submit(forked, "hi");
		const renamed: SessionRef = { backend: "claude", id: "fork-real" };
		expect(sessions.canonicalRef(forked)).toEqual(renamed);

		await sessions.close(renamed);

		// The pre-rename spelling is the one key `close()` could not know to
		// clear. A recipe still parked under it would fork the PARENT a second
		// time and hand the caller that as the session it asked for.
		await expect(sessions.attach(forked)).rejects.toBeInstanceOf(UnknownSessionError);
		expect(claude.created).toHaveLength(2);
	});

	it("discards the recipe parked under a name the fork's start renamed away from, when closed under the new one", async () => {
		// OW-hojefo's Codex first-message fork parks its recipe under a
		// `virtual:` ref and renames to its thread inside `start()`. A close
		// under the thread id during that start must not leave the recipe parked
		// under the old name, or the next attach of it starts the fork again.
		const claudeRef: SessionRef = { backend: "claude", id: "parent" };
		const claude = new FakeAdapterFactory({ forkMode: "claude" });
		const gate = deferred();
		const renamedInside = deferred();
		const create = claude.create.bind(claude);
		claude.create = (ref) => {
			const adapter = create(ref);
			if (ref.id.includes("#fork-")) {
				const start = adapter.start.bind(adapter);
				adapter.start = async (opts) => {
					await start(opts);
					adapter.materialiseAs("fork-thread");
					renamedInside.resolve();
					await gate.promise;
				};
			}
			return adapter;
		};
		index = new FakeSessionIndex([storedSession(claudeRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		await sessions.attach(claudeRef);
		const forked = await sessions.fork(claudeRef, "e1");
		const attaching = sessions.attach(forked);
		await renamedInside.promise;

		await sessions.close({ backend: "claude", id: "fork-thread" });
		gate.resolve();
		await expect(attaching).rejects.toBeInstanceOf(UnknownSessionError);

		await expect(sessions.attach(forked)).rejects.toBeInstanceOf(UnknownSessionError);
		expect(claude.created).toHaveLength(2);
	});

	it("discards the recipe of a fork whose start renamed it and failed, when closed under the new name during the reaping (OW-kamave)", async () => {
		// The failure takes the fork's container out of the table, so the close
		// finds none: only the startup still answers to both names.
		const claudeRef: SessionRef = { backend: "claude", id: "parent" };
		const claude = new FakeAdapterFactory({ forkMode: "claude" });
		let releaseDispose: (() => void) | undefined;
		const reaping = deferred();
		const create = claude.create.bind(claude);
		claude.create = (ref) => {
			const adapter = create(ref);
			if (ref.id.includes("#fork-") && !releaseDispose) {
				adapter.start = async () => {
					adapter.materialiseAs("fork-thread");
					releaseDispose = holdDispose(adapter);
					reaping.resolve();
					throw new Error("fork refused");
				};
			}
			return adapter;
		};
		index = new FakeSessionIndex([storedSession(claudeRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		await sessions.attach(claudeRef);
		const forked = await sessions.fork(claudeRef, "e1");
		const failing = sessions.attach(forked);
		await reaping.promise;
		await settle();

		let closed = false;
		const closing = sessions.close({ backend: "claude", id: "fork-thread" }).then(() => {
			closed = true;
		});
		await settle();
		expect(closed).toBe(false);
		releaseDispose?.();
		await closing;
		await expect(failing).rejects.toThrow("fork refused");

		// A recipe left parked would fork the parent again for a session the
		// caller has closed.
		await expect(sessions.attach(forked)).rejects.toBeInstanceOf(UnknownSessionError);
		expect(claude.created).toHaveLength(2);
		expect(claude.created.filter((adapter) => adapter.startOptions?.forkOf)).toEqual([]);
	});

	// What a ref-changing fork leaves behind for the PARENT (OW-kekoji). The
	// adapter genuinely moves -- the one live adapter is driving the fork now,
	// from a container of the fork's own -- but the parent is a second
	// conversation, not an older name for this one, so none of its names goes
	// with it and the parent's ref stops resolving at all.
	// It is detached, in the sense D9 and D12 already define, and the next
	// attach rehydrates it. Pi is the only backend that reaches this now
	// (OW-razoki), and the index below still reports the parent's stored session
	// because Pi's fork leaves the pre-fork file byte-identical (OW-pifowo).
	it("leaves the parent detached rather than aliased onto the fork", async () => {
		await sessions.attach(REF);
		const parentAdapter = pi.forRef(REF);

		const forked = await sessions.fork(REF, "e1");

		// The live adapter answers under the fork's ref only. A parent ref that
		// still resolved would hand a client a handle on the fork's agent.
		expect(sessions.adapterFor(forked)).toBe(parentAdapter);
		expect(sessions.adapterFor(REF)).toBeUndefined();
		expect(sessions.canonicalRef(REF)).toEqual(REF);
		expect(sessions.summaryOf(REF)).toBeNull();
	});

	describe("what the adapter emits from inside a ref-changing fork (OW-zovaye)", () => {
		// `PiAdapter.fork` moves its ref onto the fork, then re-reads the fork's
		// rewound transcript and emits it -- all before `fork()` returns. When the
		// manager re-keyed only once `fork()` settled, that went out under the
		// PARENT's ref, and every client showing the parent redrew it shortened.
		// The adapter now announces the move first (`onRefChanged`), so the
		// container is under the fork's ref before anything is emitted.
		const moved: SessionRef = { backend: "pi", id: `${REF.id}#fork-e1` };

		function collectEvents(): ServerEvent[] {
			const events: ServerEvent[] = [];
			broadcaster.addClient((chunk) => {
				for (const line of chunk.split("\n")) {
					if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as ServerEvent);
				}
			});
			return events;
		}

		const under = (ref: SessionRef, events: ServerEvent[]) =>
			events.filter((event) => "session" in event && sessionKey(event.session) === sessionKey(ref));

		/** Attach the parent, and make its fork do what `PiAdapter.fork` does, in its order. */
		async function attachRewindingOnFork(options: { before?: () => Promise<void>; fail?: Error } = {}): Promise<FakeAdapter> {
			await sessions.attach(REF);
			const adapter = pi.forRef(REF);
			if (!adapter) throw new Error("no adapter");
			adapter.messages = [userMessage("one"), userMessage("two")];
			const fork = adapter.fork.bind(adapter);
			adapter.fork = async (entryId) => {
				await options.before?.();
				// The fake's default "pi" mode moves the ref.
				const forked = await fork(entryId);
				adapter.messages = adapter.messages.slice(0, 1);
				adapter.emitTranscriptReplaced();
				if (options.fail) throw options.fail;
				return forked;
			};
			return adapter;
		}

		it("sends nothing under the parent's ref, and the fork's attach snapshots the rewound transcript", async () => {
			await attachRewindingOnFork();
			const events = collectEvents();

			expect(await sessions.fork(REF, "e1")).toEqual(moved);
			// The parent's handle ending is all that names it (D26).
			expect(under(REF, events).map((event) => event.type)).toEqual(["ended"]);

			await sessions.attach(moved);
			expect(under(moved, events).findLast((event) => event.type === "snapshot")).toMatchObject({
				messages: [userMessage("one")],
			});
		});

		it("sends nothing under the parent's ref when the fork fails after emitting", async () => {
			await attachRewindingOnFork({ fail: new Error("get_messages failed") });
			const events = collectEvents();

			await expect(sessions.fork(REF, "e1")).rejects.toThrow("get_messages failed");
			expect(under(REF, events).map((event) => event.type)).toEqual(["ended"]);
			// Re-keyed all the same: the live adapter is on the fork.
			expect(sessions.liveRefs()).toEqual([moved]);
		});

		it("sends nothing the second fork emits under the first fork's ref, while it is in flight", async () => {
			// Two clients can fork one session at once: both look the parent's
			// container up before either `fork()` settles. The first moves the
			// adapter onto its fork's container, so the second, queued behind it on
			// the parent's, finds no adapter there and fails as on any detached
			// session (OW-suyinu). A second fork of the adapter is one sent on the
			// first fork's ref, and what it emits goes out under its own.
			const firstGate = deferred();
			const secondGate = deferred();
			const gates = [firstGate.promise, secondGate.promise];
			await attachRewindingOnFork({ before: () => gates.shift() as Promise<void> });
			const events = collectEvents();

			const first = sessions.fork(REF, "e1");
			const queuedOnParent = sessions.fork(REF, "e2");
			firstGate.resolve();
			expect(await first).toEqual(moved);
			await expect(queuedOnParent).rejects.toBeInstanceOf(UnknownSessionError);
			const second = sessions.fork(moved, "e2");
			const fromSecond = events.length;
			secondGate.resolve();
			const again = await second;

			// The first fork's handle ends, as any parent's does (D26).
			expect(under(moved, events.slice(fromSecond)).map((event) => event.type)).toEqual(["ended"]);
			expect(under(again, events.slice(fromSecond)).map((event) => event.type)).toEqual(["snapshot"]);
		});

		it("answers a pull of the parent's ref with nothing of the fork, and what the fork raises goes out under its ref (OW-nuzepi)", async () => {
			// The window OW-zovaye's guard missed: the adapter has moved onto the fork
			// and rewound, and `fork()` has not returned. A snapshot is pulled, not
			// pushed -- a stream's snapshot of the parent's handle, a new stream's
			// opening snapshots -- and `onError` reaches the container.
			await sessions.attach(REF);
			const parentHandle = sessions.summaryOf(REF)?.handle ?? "";
			const adapter = pi.forRef(REF);
			if (!adapter) throw new Error("no adapter");
			adapter.messages = [userMessage("one"), userMessage("two")];
			const rewound = deferred();
			const hold = deferred();
			const fork = adapter.fork.bind(adapter);
			adapter.fork = async (entryId) => {
				const forked = await fork(entryId);
				adapter.messages = adapter.messages.slice(0, 1);
				rewound.resolve();
				await hold.promise;
				return forked;
			};
			const events: ServerEvent[] = [];
			const client = broadcaster.addClient((chunk) => {
				for (const line of chunk.split("\n")) {
					if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as ServerEvent);
				}
			});
			const forking = sessions.fork(REF, "e1");
			await rewound.promise;

			broadcaster.sendSnapshot(client, parentHandle);
			broadcaster.sendOpeningSnapshots(client, sessions.liveHandles());
			adapter.emitError("the fork's turn failed");

			// The parent's handle ending, when the fork moved the adapter, is all
			// that names it (D26).
			expect(under(REF, events).map((event) => event.type)).toEqual(["ended"]);
			expect(under(moved, events).map((event) => event.type)).toEqual(["snapshot", "error"]);
			expect(under(moved, events)[0]).toMatchObject({ messages: [userMessage("one")] });
			hold.resolve();
			expect(await forking).toEqual(moved);
		});

		it("sends a snapshot under the handle before the first thing it broadcasts under a ref the adapter took with no fork in flight", async () => {
			// A rename, not a fork: `ClaudeAdapter` adopts the id a `system init`
			// reports whenever it arrives, mid-turn included (OW-hikefi). The
			// container follows at once, and every client has the new ref, under
			// the handle it already holds, before the turn's first upsert under it
			// reaches it.
			await sessions.attach(REF);
			const handle = sessions.summaryOf(REF)?.handle;
			const adapter = pi.forRef(REF);
			if (!adapter) throw new Error("no adapter");
			const events = collectEvents();
			const renamed: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/renamed.jsonl" };

			adapter.materialiseAs(renamed.id);
			adapter.append(userMessage("hello"));

			expect(under(REF, events)).toEqual([]);
			expect(under(renamed, events)).toMatchObject([
				{ type: "snapshot", handle, messages: [] },
				{ type: "upsert", handle, index: 0 },
			]);
		});
	});

	it("does not hand the fork the parent's stored preview", async () => {
		// The fork's container is built from the parent's (`#forkOnto`), and
		// `session.stored` -- the index's answer about the PARENT -- carried
		// over would have `summaryOf` dress it in the fork's ref. Since OW-kekoji
		// the parent is listed too, so the attach response would draw the fork's
		// row character-for-character identical to the parent's until the next
		// refetch.
		const forkedAt = "2026-08-11T09:30:00.000Z";
		sessions = new SessionManager({ index, adapters: { pi }, now: () => forkedAt }, broadcaster);
		await sessions.attach(REF);
		const parentSummary = sessions.summaryOf(REF);
		expect(parentSummary?.preview).toBe("hello");

		const forked = await sessions.fork(REF, "e1");

		const summary = sessions.summaryOf(forked);
		expect(summary?.ref).toEqual(forked);
		expect(summary?.preview).toBeNull();
		// The workspace must survive: it is what keeps the fork in the
		// cwd-filtered sidebar the user forked it from (D7).
		expect(summary?.cwd).toBe(WORKSPACE);
		// And the stamps are the fork's moment, not the parent's. `#start` seeded
		// this container's `createdAt` from the parent's stored summary, so
		// leaving it would sort a brand-new fork by a date days older than itself
		// -- `recency()` in `src/client/time.ts` reads `updatedAt ?? createdAt`,
		// and the row renders `updatedAt`.
		expect(summary?.createdAt).toBe(forkedAt);
		expect(summary?.updatedAt).toBe(forkedAt);
		expect(parentSummary?.updatedAt).not.toBe(forkedAt);
	});

	it("keeps the parent in list() after a ref-changing fork", async () => {
		await sessions.attach(REF);

		const forked = await sessions.fork(REF, "e1");

		// The index still reports the parent -- its store file is untouched --
		// and no held container has it as an outgrown name, so a client can see it and
		// re-attach to it alongside the fork.
		const listed = await sessions.list().then((l) => l.map((s) => sessionKey(s.ref)));
		expect(listed).toContain(sessionKey(forked));
		expect(listed).toContain(sessionKey(REF));
	});

	it("keeps the parent in list() when a Codex-style fork leaves the ref unchanged", async () => {
		// The contrast: the parent's container keeps its ref, so it stays listed.
		const codexRef: SessionRef = { backend: "codex", id: "thread-parent" };
		const codex = new FakeAdapterFactory({ forkMode: "codex" });
		index = new FakeSessionIndex([storedSession(codexRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(codexRef);

		await sessions.fork(codexRef, "e1");

		const listed = await sessions.list();
		expect(listed.map((s) => sessionKey(s.ref))).toEqual([sessionKey(codexRef)]);
	});

	it("leaves the fork's live adapter alone when the parent's ref is closed", async () => {
		// `close()` is what the DELETE route calls (app.ts). The parent is
		// detached, so the call finds nothing and returns silently -- the route
		// still answers 204 -- and the agent the fork is driving lives on.
		await sessions.attach(REF);
		const parentAdapter = pi.forRef(REF);

		const forked = await sessions.fork(REF, "e1");
		await expect(sessions.close(REF)).resolves.toBeUndefined();

		expect(parentAdapter?.disposed).toBe(false);
		expect(sessions.isAttached(forked)).toBe(true);
		expect(sessions.liveRefs()).toEqual([forked]);
	});

	it("puts no fork's container into the table for a session closed while its fork was in flight", async () => {
		// DELETE and POST .../fork are plain concurrent handlers under
		// `Bun.serve` (app.ts); nothing serializes them. `close()` empties the
		// table before its first await, and the adapter announces its move long
		// afterwards -- here, once Pi's parked fork round trip resumes. Were the
		// container still subscribed, that would put a fork's container into
		// `#sessions`, with an adapter that is already disposed, and
		// `#disposing` never catches it because `close()` computed its keys
		// before the fork.
		await sessions.attach(REF);
		const adapter = pi.created[0];
		if (!adapter) throw new Error("no adapter");
		const gate = deferred();
		const fork = adapter.fork.bind(adapter);
		// The fake's default "pi" mode is the one that actually moves the
		// adapter's ref; on a mode that leaves it alone nothing is announced and
		// the test proves nothing.
		adapter.fork = async (entryId) => {
			await gate.promise;
			return fork(entryId);
		};
		// `PiAdapter.dispose()` leaves its listeners subscribed, so the fake's
		// clearing of them must not stand in for the manager's unsubscription,
		// which is what this test is about.
		adapter.dispose = async () => {
			adapter.disposed = true;
		};

		const forking = sessions.fork(REF, "e1");
		await sessions.close(REF);
		gate.resolve();
		const forked = await forking;

		expect(adapter.disposed).toBe(true);
		expect(sessions.liveRefs()).toEqual([]);
		expect(sessions.isAttached(forked)).toBe(false);
	});

	it("puts no fork's container into the table for a session disposed while its fork was in flight", async () => {
		// Same window as the test above, with shutdown in place of DELETE.
		// `disposeAll()` clears the table before its first await, and the parked
		// `fork` announces its move afterwards -- so were each ManagedSession not
		// unsubscribed in that same run, it would re-insert the disposed
		// container under the fork's id, into the table shutdown just emptied.
		// `liveRefs()` then hands that dead session to a browser reconnecting
		// mid-shutdown (the event stream sends `retry: 500`), and
		// `isAttached()`/`adapterFor()` hand out its disposed adapter to the
		// abort and compact routes.
		await sessions.attach(REF);
		const adapter = pi.created[0];
		if (!adapter) throw new Error("no adapter");
		const gate = deferred();
		const fork = adapter.fork.bind(adapter);
		// As above: only the fake's default "pi" mode moves the adapter's ref, and
		// on any other mode nothing is announced.
		adapter.fork = async (entryId) => {
			await gate.promise;
			return fork(entryId);
		};
		// As above: a disposal that leaves the listeners in place, as Pi's does.
		adapter.dispose = async () => {
			adapter.disposed = true;
		};

		const forking = sessions.fork(REF, "e1");
		await sessions.disposeAll();
		gate.resolve();
		const forked = await forking;

		expect(adapter.disposed).toBe(true);
		expect(sessions.liveRefs()).toEqual([]);
		expect(sessions.isAttached(forked)).toBe(false);
	});

	it("leaves an older name of the parent resolving to nothing, not to the fork", async () => {
		// A `virtual:` id that materialised into the parent is an older name for
		// the PARENT's conversation. Handing it to the fork's container would
		// recreate the bug one level up: a stale client ref that can kill the
		// live fork.
		const renaming = new FakeAdapterFactory({
			materialiseOnSubmit: "/home/u/.pi/agent/sessions/materialised.jsonl",
		});
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi");
		await sessions.attach(virtualRef);
		await sessions.submit(virtualRef, "first");
		const parentAdapter = renaming.forRef(virtualRef);

		const forked = await sessions.fork(virtualRef, "e1");

		// The name left with the parent's container, which is now detached, so it
		// misses -- and a miss is what `canonicalRef` reports by handing `ref`
		// back. Had it gone to the fork's container it would resolve to the fork.
		expect(sessions.canonicalRef(virtualRef)).toEqual(virtualRef);
		expect(sessions.canonicalRef(virtualRef)).not.toEqual(forked);
		expect(sessions.adapterFor(virtualRef)).toBeUndefined();
		await sessions.close(virtualRef);
		expect(parentAdapter?.disposed).toBe(false);
	});

	it("rejects a fork on a session with no live adapter", async () => {
		await expect(sessions.fork({ backend: "pi", id: "/nope" }, "e1")).rejects.toBeInstanceOf(
			UnknownSessionError,
		);
	});
});

/**
 * The container is keyed by a handle the manager mints, and every backend id
 * the conversation has had is a name on it (D24, OW-suyinu). A rename adds a
 * name; a fork is a new container with a new handle.
 */
describe("a container keyed by a handle", () => {
	const REAL = "/home/u/.pi/agent/sessions/materialised.jsonl";
	const handleOf = (ref: SessionRef) => sessions.summaryOf(ref)?.handle;

	// A browser tab and the Emacs helper outlive a server restart, and key their
	// live views by the handle (OW-kimaya), so a second process's first handle
	// must not be the first process's.
	it("mints a first handle no other manager mints, as a restarted server's would be", () => {
		const restarted = new SessionManager({ index, adapters: { pi } }, new Broadcaster());
		const before = handleOf(sessions.createVirtual(WORKSPACE, "pi"));
		const after = restarted.summaryOf(restarted.createVirtual(WORKSPACE, "pi"))?.handle;
		expect(before).toEqual(expect.any(String));
		expect(after).toEqual(expect.any(String));
		expect(after).not.toBe(before);
	});

	it("is reachable by all three names after two renames, and holds one handle throughout", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi");
		const handle = handleOf(virtualRef);
		expect(handle).toEqual(expect.any(String));

		const adapter = await sessions.attach(virtualRef);
		const later: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/later.jsonl" };
		renaming.forRef(virtualRef)?.materialiseAs(later.id);

		for (const name of [virtualRef, { backend: "pi", id: REAL } as SessionRef, later]) {
			expect(handleOf(name)).toBe(handle);
			expect(sessions.adapterFor(name)).toBe(adapter);
			expect(sessions.canonicalRef(name)).toEqual(later);
		}
		expect(sessions.liveHandles()).toEqual([handle]);
	});

	it("gives a Pi-style fork a new handle and none of the parent's names, and leaves no name of the parent resolving", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		await sessions.attach(REF);
		const real: SessionRef = { backend: "pi", id: REAL };
		const parentHandle = handleOf(REF);
		expect(parentHandle).toEqual(expect.any(String));
		expect(handleOf(real)).toBe(parentHandle);

		const forked = await sessions.fork(real, "e1");

		const forkHandle = handleOf(forked);
		expect(forkHandle).toEqual(expect.any(String));
		expect(forkHandle).not.toBe(parentHandle);
		for (const name of [REF, real]) {
			expect(sessions.summaryOf(name)).toBeNull();
			expect(sessions.adapterFor(name)).toBeUndefined();
		}
		expect(sessions.liveHandles()).toEqual([forkHandle]);

		// Detached, so the next attach resumes the parent from the index into a
		// container of its own, and the fork's is untouched.
		await sessions.attach(REF);
		expect(renaming.created).toHaveLength(2);
		expect(handleOf(REF)).not.toBe(parentHandle);
		expect(handleOf(REF)).not.toBe(forkHandle);
		expect(handleOf(forked)).toBe(forkHandle);
	});

	it("records a spelling `#start` canonicalised as a name on the container, whichever attach won", async () => {
		const canonical: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/ws/a.jsonl" };
		const spellingA: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/ws/../ws/a.jsonl" };
		const spellingB: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/other/../ws/a.jsonl" };
		const spellingC: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/./ws/a.jsonl" };
		const summary = storedSession(canonical, WORKSPACE);
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async () => summary,
			preview: async () => [],
		};
		sessions = new SessionManager({ index: canonicalizingIndex, adapters: { pi } }, broadcaster);

		// A starts the container, B joins its startup, and C arrives once it is live.
		await Promise.all([sessions.attach(spellingA), sessions.attach(spellingB)]);
		await sessions.attach(spellingC);

		const handle = handleOf(canonical);
		expect(handle).toEqual(expect.any(String));
		for (const spelling of [spellingA, spellingB, spellingC]) expect(handleOf(spelling)).toBe(handle);
		expect(pi.created).toHaveLength(1);
	});

	it("unsubscribes the adapter a Pi fork took when the fork's container is closed", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF)!;
		// As in the teardown tests: a disposal that leaves the listeners in place,
		// as Pi's does, so only the manager's unsubscription can deafen it.
		adapter.dispose = async () => {
			adapter.disposed = true;
		};
		const forked = await sessions.fork(REF, "e1");

		await sessions.close(forked);
		const frames: string[] = [];
		broadcaster.addClient((chunk) => frames.push(chunk));
		adapter.append(userMessage("after the close"));
		adapter.materialiseAs("/home/u/.pi/agent/sessions/after.jsonl");

		expect(frames.filter((frame) => frame.startsWith("data: "))).toEqual([]);
		expect(sessions.liveHandles()).toEqual([]);
		expect(sessions.summaryOf({ backend: "pi", id: "/home/u/.pi/agent/sessions/after.jsonl" })).toBeNull();
	});

	it("leaves a closed container reachable by no name", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		await sessions.attach(REF);
		const real: SessionRef = { backend: "pi", id: REAL };
		const handle = handleOf(REF);
		expect(handle).toEqual(expect.any(String));

		await sessions.close(real);

		for (const name of [REF, real]) {
			expect(sessions.summaryOf(name)).toBeNull();
			expect(sessions.adapterFor(name)).toBeUndefined();
		}
		expect(sessions.liveHandles()).toEqual([]);
		// Only the index answers for it now, and it holds no handle.
		expect((await sessions.list()).map((row) => [sessionKey(row.ref), row.handle])).toEqual([[sessionKey(REF), undefined]]);
	});
});

describe("a fork that shares the parent's subprocess (OW-lajehi)", () => {
	// Codex's shape as of `codex-cli` 0.154.0: a forked thread can only be
	// opened by the app-server that minted it, so `fork()` hands back an adapter
	// it built itself, already holding a share of the parent's child. The
	// manager must start THAT adapter instead of asking the factory for one, and
	// the child must outlive every holder but the last.
	const parentRef: SessionRef = { backend: "codex", id: "thread-parent" };
	const forkRef: SessionRef = { backend: "codex", id: "thread-parent#fork-e1" };
	let child: FakeSharedChild;
	let codex: FakeAdapterFactory;

	beforeEach(() => {
		child = new FakeSharedChild();
		codex = new FakeAdapterFactory({ forkMode: "shared", sharedChild: child });
		index = new FakeSessionIndex([storedSession(parentRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
	});

	it("attaches the fork on the adapter fork() handed over, spawning nothing new", async () => {
		await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "e1");
		expect(forked).toEqual(forkRef);

		const forkAdapter = (await sessions.attach(forked)) as FakeAdapter;

		// One adapter from the factory -- the parent's. The fork's came from the
		// parent adapter, and the factory never saw the fork's ref.
		expect(codex.created).toHaveLength(1);
		expect(codex.createdFor).toEqual([parentRef]);
		expect(forkAdapter).not.toBe(codex.created[0]);
		expect(sessions.liveRefs()).toEqual([parentRef, forkRef]);
		// Two live sessions, one child.
		expect(child.holders).toBe(2);
		expect(child.kills).toBe(0);
		// Started as a resume of the already-flushed fork, in the parent's cwd.
		expect(forkAdapter.startOptions).toEqual({ cwd: WORKSPACE, resumeId: forkRef.id });
	});

	it("keeps the fork driving the shared child after the parent is closed", async () => {
		await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "e1");
		const forkAdapter = (await sessions.attach(forked)) as FakeAdapter;

		await sessions.close(parentRef);

		expect(child.kills).toBe(0);
		expect(child.holders).toBe(1);
		await sessions.submit(forked, "still here");
		expect(forkAdapter.prompts).toEqual([{ text: "still here", images: undefined }]);
	});

	it("keeps the parent driving the shared child after the fork is closed", async () => {
		const parent = (await sessions.attach(parentRef)) as FakeAdapter;
		const forked = await sessions.fork(parentRef, "e1");
		await sessions.attach(forked);

		await sessions.close(forked);

		expect(child.kills).toBe(0);
		await sessions.submit(parentRef, "still here");
		expect(parent.prompts).toEqual([{ text: "still here", images: undefined }]);
	});

	it("kills the shared child exactly once when shutdown disposes both holders", async () => {
		await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "e1");
		await sessions.attach(forked);

		await sessions.disposeAll();

		expect(child.holders).toBe(0);
		expect(child.kills).toBe(1);
	});

	it("releases a fork nobody ever attached, so the parent\'s child can still die", async () => {
		// The share is taken at fork time, not at attach, so an abandoned fork
		// pins the parent\'s process. `close()` on the fork\'s ref is the browser
		// path out of that, and shutdown is the other.
		await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "e1");
		expect(child.holders).toBe(2);

		await sessions.close(forked);
		expect(child.holders).toBe(1);
		expect(child.kills).toBe(0);

		await sessions.close(parentRef);
		expect(child.kills).toBe(1);
	});

	it("discards the handle and releases the share when the fork's own start fails", async () => {
		// A handle is single-use: it leaves `#pendingForks` at the claim, and the
		// reaping disposes its adapter, which releases the share, so a retry
		// finds no dead adapter parked. A recipe is replayable and is
		// deliberately kept -- this is where the two shapes part company.
		codex = new FakeAdapterFactory({
			forkMode: "shared",
			sharedChild: child,
			forkOptions: { failStart: "fork refused" },
		});
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "e1");

		await expect(sessions.attach(forked)).rejects.toThrow("fork refused");

		// The share the failed borrower held is back, so the parent's child is
		// the parent's alone again.
		expect(child.holders).toBe(1);
		expect(child.kills).toBe(0);
		// And the parked entry is gone: the index has never heard of the fork, so
		// a retry gets the honest 404 rather than a dead adapter.
		await expect(sessions.attach(forked)).rejects.toBeInstanceOf(UnknownSessionError);
		await sessions.close(parentRef);
		expect(child.kills).toBe(1);
	});

	it("survives the parent being closed while the fork's attach is in flight", async () => {
		// The interleaving the "share taken at fork time" decision exists to make
		// safe. `#disposing` is keyed per session, so `close(parent)` does not gate
		// `attach(fork)`: without the share already held, the parent's release
		// would kill the child under the borrower's resume.
		const gate = deferred();
		codex = new FakeAdapterFactory({
			forkMode: "shared",
			sharedChild: child,
			forkOptions: { holdStart: gate.promise },
		});
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "e1");

		const attaching = sessions.attach(forked);
		await sessions.close(parentRef);
		expect(child.kills).toBe(0);
		gate.resolve();

		const forkAdapter = (await attaching) as FakeAdapter;
		expect(forkAdapter.started).toBe(true);
		expect(child.holders).toBe(1);
		expect(child.kills).toBe(0);
		expect(sessions.liveRefs()).toEqual([forkRef]);
	});

	it("releases the share when shutdown drops a fork nobody attached", async () => {
		await sessions.attach(parentRef);
		await sessions.fork(parentRef, "e1");

		await sessions.disposeAll();

		expect(child.holders).toBe(0);
		expect(child.kills).toBe(1);
	});

	/**
	 * The adapter the parent's `fork()` builds, which the factory never sees.
	 * Read once the fork has been taken.
	 */
	function capturingForks(): () => FakeAdapter {
		const parent = codex.created[0];
		if (!parent) throw new Error("no parent adapter");
		const fork = parent.fork.bind(parent);
		let built: FakeAdapter | undefined;
		parent.fork = async (entryId) => {
			const forked = await fork(entryId);
			built = forked.adapter as FakeAdapter;
			return forked;
		};
		return () => {
			if (!built) throw new Error("no fork adapter");
			return built;
		};
	}

	it("refuses the attach of a fork closed while it was starting, and disposes its adapter once", async () => {
		const gate = deferred();
		codex = new FakeAdapterFactory({
			forkMode: "shared",
			sharedChild: child,
			forkOptions: { holdStart: gate.promise },
		});
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(parentRef);
		const forkAdapter = capturingForks();
		const forked = await sessions.fork(parentRef, "e1");
		const release = holdDispose(forkAdapter());

		const attaching = sessions.attach(forked);
		await settle();
		const closing = sessions.close(forked);
		// The fork's start completes while the close is still disposing.
		gate.resolve();
		for (let i = 0; i < 4; i++) await settle();
		release();
		await closing;

		await expect(attaching).rejects.toBeInstanceOf(UnknownSessionError);
		expect(sessions.isAttached(forked)).toBe(false);
		expect(forkAdapter().disposals).toBe(1);
	});

	it("spawns nothing on a closed fork's thread while its parked adapter is still being disposed", async () => {
		// The fork is on disk, as Codex's is, so an attach that finds no parked
		// entry can resume it through the index on an adapter of its own.
		index.summaries.push(storedSession(forkRef, WORKSPACE));
		await sessions.attach(parentRef);
		const forkAdapter = capturingForks();
		const forked = await sessions.fork(parentRef, "e1");
		const release = holdDispose(forkAdapter());

		const closing = sessions.close(forked);
		const attaching = sessions.attach(forked);
		await settle();
		await settle();

		expect(codex.created).toHaveLength(1);

		release();
		await closing;
		const reopened = await attaching;
		expect(codex.created).toHaveLength(2);
		expect(reopened).toBe(codex.created[1]);
		expect(forkAdapter().disposals).toBe(1);
	});

	it("says nothing at the close of a parked fork, which has no handle for a client to hold (D26)", async () => {
		await sessions.attach(parentRef);
		const forkAdapter = capturingForks();
		const forked = await sessions.fork(parentRef, "e1");
		const events = broadcastEvents();

		await sessions.close(forked);

		expect(forkAdapter().disposals).toBe(1);
		expect(events).toEqual([]);
	});

	it("disposes a starting fork's adapter once when shutdown lands during its attach", async () => {
		const gate = deferred();
		codex = new FakeAdapterFactory({
			forkMode: "shared",
			sharedChild: child,
			forkOptions: { holdStart: gate.promise },
		});
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(parentRef);
		const forkAdapter = capturingForks();
		const forked = await sessions.fork(parentRef, "e1");

		const attaching = sessions.attach(forked);
		await settle();
		await sessions.disposeAll();
		gate.resolve();
		await expect(attaching).rejects.toThrow();

		expect(forkAdapter().disposals).toBe(1);
		expect(child.holders).toBe(0);
	});
});

describe("lifecycle", () => {
	it("keeps virtual sessions out of the backend store until prompted (D9)", async () => {
		const ref = sessions.createVirtual(WORKSPACE, "pi", "pi-1");
		expect(pi.created).toHaveLength(0);

		await sessions.attach(ref);
		expect(pi.forRef(ref)?.startOptions).toEqual({ cwd: WORKSPACE, model: "pi-1" });

		const before = await sessions.list();
		expect(before.find((s) => sessionKey(s.ref) === sessionKey(ref))?.status).toBe("attached");

		sessions.markPrompted(ref);
		// Still attached; "virtual" was only ever about the store, not the process.
		const after = await sessions.list();
		expect(after.find((s) => sessionKey(s.ref) === sessionKey(ref))?.status).toBe("attached");
	});

	it("resumes a closed Pi session with no model, leaving Pi to restore the one its file recorded (OW-pubulu, D23)", async () => {
		// As of `pi 0.87.1` a `--session` resume runs the model and level the file
		// last recorded, and a `--model <m>:<level>` would override the level
		// (docs/MANUAL_TESTING.md, OW-ruzuhu and OW-pubulu).
		const real: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/materialised.jsonl" };
		index = new FakeSessionIndex([storedSession(real, WORKSPACE)]);
		const renaming = new FakeAdapterFactory({ materialiseOnSubmit: real.id });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi", "openrouter/deepseek/deepseek-v4.1-flash:high");
		await sessions.attach(virtualRef);
		await sessions.submit(virtualRef, "first");
		await sessions.close(real);

		await sessions.attach(real);

		expect(renaming.created).toHaveLength(2);
		expect(renaming.created[0]?.startOptions).toEqual({
			cwd: WORKSPACE,
			model: "openrouter/deepseek/deepseek-v4.1-flash:high",
		});
		expect(renaming.created[1]?.startOptions).toEqual({ cwd: WORKSPACE, resumeId: real.id });
	});

	it("disposes everything on shutdown, and only then", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF);
		expect(adapter?.disposed).toBe(false);

		await sessions.disposeAll();
		expect(adapter?.disposed).toBe(true);
		expect(sessions.liveRefs()).toEqual([]);
	});

	it("shutdown does not stop at the first adapter that fails to die", async () => {
		// Every session left undisposed on shutdown is a sandboxed agent still
		// holding its workspace, so one casualty must not spare the rest.
		const brittle = new FakeAdapterFactory({ failDispose: "kill: no such process" });
		sessions = new SessionManager({ index, adapters: { pi: brittle } }, broadcaster);
		const a = sessions.createVirtual(WORKSPACE, "pi");
		const b = sessions.createVirtual(WORKSPACE, "pi");
		await sessions.attach(a);
		await sessions.attach(b);

		await expect(sessions.disposeAll()).resolves.toBeUndefined();
		expect(brittle.created.map((c) => c.disposed)).toEqual([true, true]);
	});

	it("an explicit close survives an adapter that throws on dispose", async () => {
		const brittle = new FakeAdapterFactory({ failDispose: "kill: no such process" });
		sessions = new SessionManager({ index, adapters: { pi: brittle } }, broadcaster);
		await sessions.attach(REF);

		await expect(sessions.close(REF)).resolves.toBeUndefined();
		expect(sessions.isAttached(REF)).toBe(false);
	});

	it("waits for a closing adapter to be disposed before attaching its replacement", async () => {
		const canonical: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/materialised.jsonl",
		};
		pi = new FakeAdapterFactory({ materialiseOnStart: canonical.id });
		sessions = new SessionManager({ index, adapters: { pi } }, broadcaster);
		await sessions.attach(REF);
		const first = pi.created[0];
		if (!first) throw new Error("no adapter");
		index.summaries = [storedSession(REF, WORKSPACE), storedSession(canonical, WORKSPACE)];
		const gate = deferred();
		const dispose = first.dispose.bind(first);
		first.dispose = async () => {
			await gate.promise;
			await dispose();
		};

		const closing = sessions.close(REF);
		const throughAlias = sessions.attach(REF);
		const throughCanonical = sessions.attach(canonical);
		// Give an unguarded attach enough turns to reach the synchronous create().
		for (let i = 0; i < 4; i++) await Promise.resolve();

		expect(pi.created).toHaveLength(1);

		gate.resolve();
		await closing;
		const [aliasAdapter, canonicalAdapter] = await Promise.all([throughAlias, throughCanonical]);
		expect(first.disposed).toBe(true);
		expect(pi.created).toHaveLength(2);
		expect(aliasAdapter).toBe(canonicalAdapter);
	});

	it("says a close ended the handle, and that the list changed, before the adapter's disposal settles (D26, OW-sodohi)", async () => {
		// Up to the kill's grace passes between the forget and the disposal
		// settling, and a client that heard nothing meanwhile held a view whose
		// Send met 409.
		await sessions.attach(REF);
		const handle = sessions.summaryOf(REF)?.handle;
		const adapter = pi.created[0];
		if (!adapter) throw new Error("no adapter");
		const release = holdDispose(adapter);
		const events = broadcastEvents();

		const closing = sessions.close(REF);
		await settle();

		const said = [{ type: "ended", session: REF, handle }, { type: "sessions-changed" }];
		expect(events).toEqual(said);
		release();
		await closing;
		expect(events).toEqual(said);
	});

	it("resolves shutdown only once a close has disposed the session's adapter", async () => {
		await sessions.attach(REF);
		const adapter = pi.created[0];
		if (!adapter) throw new Error("no adapter");
		const release = holdDispose(adapter);

		const closing = sessions.close(REF);
		let shutDown = false;
		const shutdown = sessions.disposeAll().then(() => {
			shutDown = true;
		});
		await settle();
		await settle();

		expect(shutDown).toBe(false);

		release();
		await shutdown;
		await closing;
		expect(adapter.disposals).toBe(1);
	});

	it("keeps a closing adapter's replacement waiting through a second close of the same session", async () => {
		// Two clients can each send the DELETE. The second finds nothing in the
		// table and has nothing to let go of, and must leave the first's
		// disposal holding the attach back.
		await sessions.attach(REF);
		const first = pi.created[0];
		if (!first) throw new Error("no adapter");
		const gate = deferred();
		const dispose = first.dispose.bind(first);
		first.dispose = async () => {
			await gate.promise;
			await dispose();
		};

		const closing = sessions.close(REF);
		await sessions.close(REF);
		const attaching = sessions.attach(REF);
		await settle();

		expect(pi.created).toHaveLength(1);

		gate.resolve();
		await closing;
		expect(await attaching).toBe(pi.created[1]);
	});

	it("canonicalizes unseen aliases before replacing a session that is still disposing", async () => {
		const canonical: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/a.jsonl",
		};
		const aliasA: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/../ws/a.jsonl",
		};
		const aliasB: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/other/../ws/a.jsonl",
		};
		const summary = storedSession(canonical, WORKSPACE);
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async () => summary,
			preview: async () => [],
		};
		sessions = new SessionManager(
			{ index: canonicalizingIndex, adapters: { pi } },
			broadcaster,
		);
		await sessions.attach(canonical);
		const first = pi.created[0];
		if (!first) throw new Error("no adapter");
		const gate = deferred();
		const dispose = first.dispose.bind(first);
		first.dispose = async () => {
			await gate.promise;
			await dispose();
		};

		const closing = sessions.close(canonical);
		const throughAliasA = sessions.attach(aliasA);
		const throughAliasB = sessions.attach(aliasB);
		for (let i = 0; i < 4; i++) await Promise.resolve();

		expect(pi.created).toHaveLength(1);

		gate.resolve();
		await closing;
		const [replacementA, replacementB] = await Promise.all([throughAliasA, throughAliasB]);

		expect(first.disposed).toBe(true);
		expect(replacementB).toBe(replacementA);
		expect(pi.created).toHaveLength(2);
		expect(sessions.canonicalRef(aliasA)).toEqual(canonical);
		expect(sessions.canonicalRef(aliasB)).toEqual(canonical);
		expect(sessions.liveRefs()).toEqual([canonical]);
	});

	it("rechecks canonical disposal after a refreshed metadata lookup crosses a second close", async () => {
		const canonical: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/a.jsonl",
		};
		const alias: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/../ws/a.jsonl",
		};
		const summary = storedSession(canonical, WORKSPACE);
		const refreshedLookupEntered = deferred();
		const releaseRefreshedLookup = deferred();
		let gets = 0;
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async () => {
				gets++;
				if (gets === 3) {
					refreshedLookupEntered.resolve();
					await releaseRefreshedLookup.promise;
				}
				return summary;
			},
			preview: async () => [],
		};
		sessions = new SessionManager(
			{ index: canonicalizingIndex, adapters: { pi } },
			broadcaster,
		);
		await sessions.attach(canonical);
		const first = pi.created[0];
		if (!first) throw new Error("no first adapter");
		const firstDisposal = deferred();
		const disposeFirst = first.dispose.bind(first);
		first.dispose = async () => {
			await firstDisposal.promise;
			await disposeFirst();
		};

		const closingFirst = sessions.close(canonical);
		const throughAlias = sessions.attach(alias);
		firstDisposal.resolve();
		await closingFirst;
		await refreshedLookupEntered.promise;

		await sessions.attach(canonical);
		const second = pi.created[1];
		if (!second) throw new Error("no second adapter");
		const secondDisposal = deferred();
		const disposeSecond = second.dispose.bind(second);
		second.dispose = async () => {
			await secondDisposal.promise;
			await disposeSecond();
		};
		const closingSecond = sessions.close(canonical);

		releaseRefreshedLookup.resolve();
		for (let i = 0; i < 4; i++) await Promise.resolve();

		expect(pi.created).toHaveLength(2);

		secondDisposal.resolve();
		await closingSecond;
		const replacement = await throughAlias;

		expect(pi.created).toHaveLength(3);
		expect(replacement).toBe(pi.created[2]);
		expect(sessions.canonicalRef(alias)).toEqual(canonical);
		expect(sessions.adapterFor(canonical)).toBe(replacement);
		expect(sessions.liveRefs()).toEqual([canonical]);
	});

	it("disposes an adapter whose start() failed, rather than leaking the subprocess", async () => {
		// PiAdapter.start() spawns first and only then round-trips a readiness
		// probe, so a rejection can leave a live agent behind. Dropping the
		// reference is not enough -- nothing else will ever reap it.
		const flaky = new FakeAdapterFactory({ failStart: "sbox: no git root" });
		sessions = new SessionManager({ index, adapters: { pi: flaky } }, broadcaster);

		await expect(sessions.attach(REF)).rejects.toThrow("sbox: no git root");
		expect(flaky.created[0]?.disposed).toBe(true);
	});
});

/**
 * `onDisk` is what a client asks before it previews a session it just
 * detached, and neither the id nor `virtual` can answer it: every backend
 * renames a new session at attach and writes nothing until the first turn
 * (D9), and a fork starts with no file on every backend (OW-wedupe). So the
 * answer is the index's.
 */
describe("onDisk", () => {
	const REAL = "/home/u/.pi/agent/sessions/materialised.jsonl";

	it("is true for a session attached from the store", async () => {
		await sessions.attach(REF);

		expect(sessions.summaryOf(REF)?.onDisk).toBe(true);
		expect((await sessions.list()).find((s) => sessionKey(s.ref) === sessionKey(REF))?.onDisk).toBe(true);
	});

	it("stays false for a session renamed at attach until the index lists it, and then sticks", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi");
		await sessions.attach(virtualRef);
		const real: SessionRef = { backend: "pi", id: REAL };
		expect(sessions.canonicalRef(virtualRef)).toEqual(real);

		// Renamed and prompted, and still nothing written: the id and `virtual`
		// have both moved, and neither says a file exists.
		sessions.markPrompted(real);
		expect(sessions.summaryOf(real)?.onDisk).toBe(false);
		expect((await sessions.list()).find((s) => sessionKey(s.ref) === sessionKey(real))?.onDisk).toBe(false);

		// The first turn has written the store.
		index.summaries.push(storedSession(real, WORKSPACE));
		expect((await sessions.list()).find((s) => sessionKey(s.ref) === sessionKey(real))?.onDisk).toBe(true);
		// The attach response is the other way a client learns it, and it cannot
		// ask the index: `summaryOf` has to remember what the listing saw.
		expect(sessions.summaryOf(real)?.onDisk).toBe(true);
	});

	it("is false for a fork attached from its recipe", async () => {
		const claudeRef: SessionRef = { backend: "claude", id: "parent" };
		const claude = new FakeAdapterFactory({ forkMode: "claude" });
		index = new FakeSessionIndex([storedSession(claudeRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		await sessions.attach(claudeRef);
		const forked = await sessions.fork(claudeRef, "e1");

		await sessions.attach(forked);

		expect(sessions.summaryOf(forked)?.onDisk).toBe(false);
		expect((await sessions.list()).find((s) => sessionKey(s.ref) === sessionKey(forked))?.onDisk).toBe(false);
	});

	it("is false for a fork that moved the parent's container, whose answer was the parent's", async () => {
		await sessions.attach(REF);
		expect(sessions.summaryOf(REF)?.onDisk).toBe(true);

		const forked = await sessions.fork(REF, "e1");

		expect(sessions.summaryOf(forked)?.onDisk).toBe(false);
		expect((await sessions.list()).find((s) => sessionKey(s.ref) === sessionKey(forked))?.onDisk).toBe(false);
	});
});

describe("holds, what the preview route asks before it answers gone (D26 point 5)", () => {
	it("holds a name in the table, and nothing it never heard of", async () => {
		const ref = sessions.createVirtual(WORKSPACE, "pi");
		expect(sessions.holds(ref)).toBe(true);
		expect(sessions.holds(REF)).toBe(false);
	});

	it("holds a startup still in its index lookup, before any container exists", async () => {
		const lookup = deferred();
		const held: SessionIndex = {
			list: (query) => index.list(query),
			get: async (ref) => {
				await lookup.promise;
				return index.get(ref);
			},
			preview: (ref) => index.preview(ref),
		};
		sessions = new SessionManager({ index: held, adapters: { pi } }, broadcaster);

		const attaching = sessions.attach(REF);
		await settle();
		expect(sessions.summaryOf(REF)).toBeNull();
		expect(sessions.holds(REF)).toBe(true);

		lookup.resolve();
		await attaching;
		expect(sessions.holds(REF)).toBe(true);
	});

	it("holds a parked fork before its attach", async () => {
		const claudeRef: SessionRef = { backend: "claude", id: "parent" };
		const claude = new FakeAdapterFactory({ forkMode: "claude" });
		index = new FakeSessionIndex([storedSession(claudeRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		await sessions.attach(claudeRef);

		const forked = await sessions.fork(claudeRef, "e1");

		expect(sessions.summaryOf(forked)).toBeNull();
		expect(sessions.holds(forked)).toBe(true);
	});

	it("does not hold a session whose close is still disposing it", async () => {
		const adapter = (await sessions.attach(REF)) as FakeAdapter;
		const release = holdDispose(adapter);

		const closing = sessions.close(REF);
		await settle();
		expect(adapter.disposed).toBe(false);
		expect(sessions.holds(REF)).toBe(false);

		release();
		await closing;
	});
});

describe("teardown racing a startup", () => {
	// `start()` is the window in which an adapter already owns a sandboxed child
	// but the manager has not recorded it: `#sessions` only learns about the
	// adapter once `start()` resolves. A teardown that walks the table during
	// that window sees nothing to kill, and the child that surfaces a moment
	// later has nothing left that will ever reap it. Both real adapters take a
	// round trip inside `start()` -- Codex's `initialize`, Pi's `get_state` --
	// so this window is milliseconds wide on every single attach.

	it("disposes an adapter that was still starting when its session closed", async () => {
		const gate = deferred();
		const slow = new FakeAdapterFactory({ holdStart: gate.promise });
		sessions = new SessionManager({ index, adapters: { pi: slow } }, broadcaster);
		const ref = sessions.createVirtual(WORKSPACE, "pi");

		const attaching = sessions.attach(ref);
		await settle();
		expect(slow.created).toHaveLength(1);

		await sessions.close(ref);
		gate.resolve();
		await expect(attaching).rejects.toThrow();

		expect(slow.created[0]?.disposed).toBe(true);
		expect(sessions.isAttached(ref)).toBe(false);
		expect(sessions.liveRefs()).toEqual([]);
	});

	it("disposes an adapter that was still starting when the server shut down", async () => {
		const gate = deferred();
		const slow = new FakeAdapterFactory({ holdStart: gate.promise });
		sessions = new SessionManager({ index, adapters: { pi: slow } }, broadcaster);
		const ref = sessions.createVirtual(WORKSPACE, "pi");

		const attaching = sessions.attach(ref);
		await settle();

		await sessions.disposeAll();
		gate.resolve();
		await expect(attaching).rejects.toThrow();

		// disposeAll() resolving is the server's licence to exit. An adapter that
		// is only disposed after it resolves is an orphaned agent.
		expect(slow.created[0]?.disposed).toBe(true);
		// Shutdown and the startup's own unwinding both hold this adapter.
		expect(slow.created[0]?.disposals).toBe(1);
	});

	it("does not spawn at all when teardown beats the adapter into existence", async () => {
		// The stored-session path awaits the index before it can know the
		// workspace, so a teardown can land before there is any adapter to
		// dispose. The startup has to notice and never spawn.
		const lookup = deferred();
		const held: SessionIndex = {
			list: (query) => index.list(query),
			get: async (ref) => {
				await lookup.promise;
				return index.get(ref);
			},
			preview: (ref) => index.preview(ref),
		};
		sessions = new SessionManager({ index: held, adapters: { pi } }, broadcaster);

		const attaching = sessions.attach(REF);
		await settle();
		await sessions.disposeAll();
		lookup.resolve();
		await expect(attaching).rejects.toThrow();

		expect(pi.created).toHaveLength(0);
	});

	it("does not resurrect a closed session when the adapter renames itself on start", async () => {
		// A rename writes the new id into the table as a name of the container.
		// Run against a session that has already been closed, it puts a name
		// back -- a closed conversation reappearing in the list under an id the
		// client never asked for.
		const gate = deferred();
		const RENAMED = "/home/u/.pi/agent/sessions/real.jsonl";
		const renaming = new FakeAdapterFactory({
			holdStart: gate.promise,
			materialiseOnStart: RENAMED,
		});
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const ref = sessions.createVirtual(WORKSPACE, "pi");

		const attaching = sessions.attach(ref);
		await settle();
		await sessions.close(ref);
		gate.resolve();
		await expect(attaching).rejects.toThrow();

		expect(sessions.liveRefs()).toEqual([]);
		// Only what the store already held, under its own id: neither the closed
		// virtual session nor the id the dying adapter adopted on its way out.
		const listed = await sessions.list({ cwd: WORKSPACE });
		expect(listed.map((s) => s.ref.id)).toEqual([REF.id]);
		expect(sessions.canonicalRef({ backend: "pi", id: RENAMED }).id).toBe(RENAMED);
	});

	it("refuses to spawn once shutdown has begun", async () => {
		// The HTTP server keeps serving while `disposeAll()` runs -- it is stopped
		// after, not before -- and disposeAll walks the startup table exactly once.
		// An attach arriving after that walk is in neither list, so it spawns a
		// sandboxed agent into a server that is already leaving, and nothing will
		// ever reap it. Killing one Codex child can take the full 3s grace, which
		// is an enormous window for a session switch or a retrying tab.
		const gate = deferred();
		const slow = new FakeAdapterFactory({ holdStart: gate.promise });
		sessions = new SessionManager({ index, adapters: { pi: slow } }, broadcaster);
		const first = sessions.createVirtual(WORKSPACE, "pi");

		const attaching = sessions.attach(first);
		await settle();
		const shutdown = sessions.disposeAll();

		// REF is on disk, so this attach can spawn on its own merits -- clearing
		// the session table does not turn it away.
		await expect(sessions.attach(REF)).rejects.toThrow();
		gate.resolve();
		await Promise.allSettled([attaching, shutdown]);

		// Only the one that was already running; the latecomer never spawned.
		expect(slow.created).toHaveLength(1);
	});

	it("closes a session whose startup then fails on its own", async () => {
		// Not a test of the shared disposal -- against the unfixed code this
		// passes, because close() disposed nothing and the failure path was the
		// only caller. Exactly-once is pinned by the shutdown case above, which
		// does go red. What this covers is that the two unwinding paths running
		// back to back leave nothing registered.
		const gate = deferred();
		const flaky = new FakeAdapterFactory({
			holdStart: gate.promise,
			failStart: "sbox: no git root",
		});
		sessions = new SessionManager({ index, adapters: { pi: flaky } }, broadcaster);
		const ref = sessions.createVirtual(WORKSPACE, "pi");

		const attaching = sessions.attach(ref);
		await settle();
		await sessions.close(ref);
		gate.resolve();
		await expect(attaching).rejects.toThrow();

		expect(flaky.created[0]?.disposals).toBe(1);
		expect(sessions.isAttached(ref)).toBe(false);
		expect(sessions.liveRefs()).toEqual([]);
	});

	it("starts afresh for an attach that follows a close of a session still in its index lookup", async () => {
		const lookup = deferred();
		const held: SessionIndex = {
			list: (query) => index.list(query),
			get: async (ref) => {
				await lookup.promise;
				return index.get(ref);
			},
			preview: (ref) => index.preview(ref),
		};
		sessions = new SessionManager({ index: held, adapters: { pi } }, broadcaster);

		const first = sessions.attach(REF);
		await settle();
		const closing = sessions.close(REF);
		const second = sessions.attach(REF);
		lookup.resolve();
		await closing;

		await expect(first).rejects.toBeInstanceOf(UnknownSessionError);
		const adapter = await second;
		expect(pi.created).toEqual([adapter]);
		expect(sessions.isAttached(REF)).toBe(true);
	});

	describe("an attach that waited out the close of a session with two names (OW-yufazo)", () => {
		// The session was attached as REF and renamed itself to C inside start(),
		// so its container had both names and the close's disposal sits under
		// each, resolving to C. An attach under REF that waits it out resumes C.
		const C: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/c.jsonl" };

		/** Close that session with its adapter's dispose held, and hold every index lookup from here on. */
		async function closeHeld() {
			index.summaries = [storedSession(REF, WORKSPACE), storedSession(C, WORKSPACE)];
			const lookup = deferred();
			let holding = false;
			const held: SessionIndex = {
				list: (query) => index.list(query),
				get: async (ref) => {
					if (holding) await lookup.promise;
					return index.get(ref);
				},
				preview: (ref) => index.preview(ref),
			};
			pi = new FakeAdapterFactory({ materialiseOnStart: C.id });
			sessions = new SessionManager({ index: held, adapters: { pi } }, broadcaster);
			await sessions.attach(REF);
			const adapter = pi.created[0];
			if (!adapter) throw new Error("no adapter");
			const releaseDispose = holdDispose(adapter);
			holding = true;
			const closing = sessions.close(C);
			return { closing, releaseDispose, releaseLookup: () => lookup.resolve() };
		}

		it("is stopped by a close under the spelling it asked for, while in its index lookup", async () => {
			const { closing, releaseDispose, releaseLookup } = await closeHeld();
			const attaching = sessions.attach(REF);
			releaseDispose();
			await closing;
			await settle();

			await sessions.close(REF);
			releaseLookup();

			await expect(attaching).rejects.toBeInstanceOf(UnknownSessionError);
			expect(pi.created).toHaveLength(1);
			expect(sessions.isAttached(C)).toBe(false);
			expect(sessions.liveRefs()).toEqual([]);
		});

		it("is stopped by a close under the spelling it asked for, while still waiting out the disposal", async () => {
			const { closing, releaseDispose, releaseLookup } = await closeHeld();
			const attaching = sessions.attach(REF);
			await settle();

			await sessions.close(REF);
			releaseDispose();
			releaseLookup();
			await closing;

			await expect(attaching).rejects.toBeInstanceOf(UnknownSessionError);
			expect(pi.created).toHaveLength(1);
			expect(sessions.isAttached(C)).toBe(false);
			expect(sessions.liveRefs()).toEqual([]);
		});

		it("is stopped by a close under the spelling it asked for when it joined another attach's startup", async () => {
			const { closing, releaseDispose, releaseLookup } = await closeHeld();
			const throughC = sessions.attach(C);
			const throughRef = sessions.attach(REF);
			releaseDispose();
			await closing;
			await settle();

			await sessions.close(REF);
			releaseLookup();

			await expect(throughC).rejects.toBeInstanceOf(UnknownSessionError);
			await expect(throughRef).rejects.toBeInstanceOf(UnknownSessionError);
			expect(pi.created).toHaveLength(1);
			expect(sessions.isAttached(C)).toBe(false);
			expect(sessions.liveRefs()).toEqual([]);
		});

		it("keeps the spelling it asked for as a name of the container it attached", async () => {
			const { closing, releaseDispose, releaseLookup } = await closeHeld();
			const attaching = sessions.attach(REF);
			releaseDispose();
			releaseLookup();
			await closing;
			await attaching;

			expect(sessions.isAttached(REF)).toBe(true);
			await sessions.close(REF);
			expect(sessions.liveRefs()).toEqual([]);
		});
	});

	it("stops the startup an unseen alias's attach collapsed into, when closed under that alias", async () => {
		const canonical: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/ws/a.jsonl" };
		const aliasA: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/ws/../ws/a.jsonl" };
		const aliasB: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/other/../ws/a.jsonl" };
		const summary = storedSession(canonical, WORKSPACE);
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async () => summary,
			preview: async () => [],
		};
		const gate = deferred();
		const slow = new FakeAdapterFactory({ holdStart: gate.promise });
		sessions = new SessionManager({ index: canonicalizingIndex, adapters: { pi: slow } }, broadcaster);

		const throughA = sessions.attach(aliasA);
		await settle();
		const throughB = sessions.attach(aliasB);
		await settle();
		await sessions.close(aliasB);
		gate.resolve();

		await expect(throughA).rejects.toBeInstanceOf(UnknownSessionError);
		await expect(throughB).rejects.toBeInstanceOf(UnknownSessionError);
		expect(slow.created).toHaveLength(1);
		expect(slow.created[0]?.disposed).toBe(true);
		expect(sessions.isAttached(canonical)).toBe(false);
		expect(sessions.liveRefs()).toEqual([]);
	});

	it("leaves another attach's startup under the canonical name when a failed start reaps its adapter (OW-yufazo)", async () => {
		// REF canonicalises to C. The attach under C is still in its index
		// lookup when REF's start fails, so the name is that attach's to be
		// found by, not the failed one's.
		const C: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/c.jsonl" };
		const summary = storedSession(C, WORKSPACE);
		const lookupOfC = deferred();
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async (ref) => {
				if (sessionKey(ref) === sessionKey(C)) await lookupOfC.promise;
				return summary;
			},
			preview: async () => [],
		};
		const disposing = deferred();
		const releaseDispose = deferred();
		const create = pi.create.bind(pi);
		pi.create = (ref) => {
			const adapter = create(ref);
			if (pi.created.length === 1) {
				adapter.start = async () => {
					throw new Error("start failed");
				};
				const dispose = adapter.dispose.bind(adapter);
				adapter.dispose = async () => {
					disposing.resolve();
					await releaseDispose.promise;
					await dispose();
				};
			}
			return adapter;
		};
		sessions = new SessionManager({ index: canonicalizingIndex, adapters: { pi } }, broadcaster);

		const throughRef = sessions.attach(REF);
		const throughC = sessions.attach(C);
		await disposing.promise;
		const closing = sessions.close(C);
		lookupOfC.resolve();
		releaseDispose.resolve();
		await closing;

		await expect(throughRef).rejects.toThrow("start failed");
		await expect(throughC).rejects.toBeInstanceOf(UnknownSessionError);
		expect(pi.created).toHaveLength(1);
		expect(sessions.liveRefs()).toEqual([]);
	});

	describe("a close under a name an attach still in its index lookup holds (OW-kamave)", () => {
		// The lookup of C is held, so an attach under C is still in it when
		// another startup's container comes to answer to C as well.
		const C: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/c.jsonl" };

		/** An index resolving every ref to C, whose lookup of C itself waits for the returned release. */
		function canonicalisingToC(): { held: SessionIndex; releaseLookup: () => void } {
			const summary = storedSession(C, WORKSPACE);
			const lookupOfC = deferred();
			const held: SessionIndex = {
				list: async () => [summary],
				get: async (ref) => {
					if (sessionKey(ref) === sessionKey(C)) await lookupOfC.promise;
					return summary;
				},
				preview: async () => [],
			};
			return { held, releaseLookup: () => lookupOfC.resolve() };
		}

		it("stops it as well as the startup of the container REF's lookup built under C", async () => {
			const { held, releaseLookup } = canonicalisingToC();
			const gate = deferred();
			const slow = new FakeAdapterFactory({ holdStart: gate.promise });
			sessions = new SessionManager({ index: held, adapters: { pi: slow } }, broadcaster);

			const throughRef = sessions.attach(REF);
			const throughC = sessions.attach(C);
			await settle();
			expect(slow.created).toHaveLength(1);

			await sessions.close(C);
			releaseLookup();
			gate.resolve();

			await expect(throughRef).rejects.toBeInstanceOf(UnknownSessionError);
			await expect(throughC).rejects.toBeInstanceOf(UnknownSessionError);
			expect(slow.created).toHaveLength(1);
			expect(slow.created[0]?.disposed).toBe(true);
			expect(sessions.liveRefs()).toEqual([]);
		});

		it("stops it when that container's startup has already published", async () => {
			const { held, releaseLookup } = canonicalisingToC();
			sessions = new SessionManager({ index: held, adapters: { pi } }, broadcaster);

			const throughRef = sessions.attach(REF);
			const throughC = sessions.attach(C);
			await throughRef;

			await sessions.close(C);
			releaseLookup();

			await expect(throughC).rejects.toBeInstanceOf(UnknownSessionError);
			expect(pi.created).toHaveLength(1);
			expect(pi.created[0]?.disposed).toBe(true);
			expect(sessions.liveRefs()).toEqual([]);
		});

		it("stops it when the name came to another container by a rename inside that container's start", async () => {
			const R: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/r.jsonl" };
			index.summaries = [storedSession(REF, WORKSPACE), storedSession(R, WORKSPACE)];
			const lookupOfR = deferred();
			const held: SessionIndex = {
				list: (query) => index.list(query),
				get: async (ref) => {
					if (sessionKey(ref) === sessionKey(R)) await lookupOfR.promise;
					return index.get(ref);
				},
				preview: (ref) => index.preview(ref),
			};
			const gate = deferred();
			const renamed = deferred();
			const factory = new FakeAdapterFactory();
			const create = factory.create.bind(factory);
			factory.create = (ref) => {
				const adapter = create(ref);
				const start = adapter.start.bind(adapter);
				adapter.start = async (opts) => {
					await start(opts);
					adapter.materialiseAs(R.id);
					renamed.resolve();
					await gate.promise;
				};
				return adapter;
			};
			sessions = new SessionManager({ index: held, adapters: { pi: factory } }, broadcaster);

			const throughR = sessions.attach(R);
			await settle();
			const throughRef = sessions.attach(REF);
			await renamed.promise;

			await sessions.close(R);
			lookupOfR.resolve();
			gate.resolve();

			await expect(throughRef).rejects.toBeInstanceOf(UnknownSessionError);
			await expect(throughR).rejects.toBeInstanceOf(UnknownSessionError);
			expect(factory.created).toHaveLength(1);
			expect(factory.created[0]?.disposed).toBe(true);
			expect(sessions.liveRefs()).toEqual([]);
		});
	});

	describe("an attach whose file a failed start is still reaping (OW-kamave)", () => {
		// The index resolves every ref to C. The first adapter's start fails and
		// its dispose is held, so its startup is reaping, its container out of
		// the table, while the other attach reaches C.
		const C: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/c.jsonl" };

		/** An index resolving every ref to C, whose lookup of C itself waits for `lookupOfC` if given. */
		function canonicalisingToC(lookupOfC?: Promise<void>): SessionIndex {
			const summary = storedSession(C, WORKSPACE);
			return {
				list: async () => [summary],
				get: async (ref) => {
					if (lookupOfC && sessionKey(ref) === sessionKey(C)) await lookupOfC;
					return summary;
				},
				preview: async () => [],
			};
		}

		/** A factory whose first adapter fails `start()`, then holds its dispose until released. */
		function failingFirst() {
			const factory = new FakeAdapterFactory();
			const disposing = deferred();
			const release = deferred();
			const create = factory.create.bind(factory);
			factory.create = (ref) => {
				const adapter = create(ref);
				if (factory.created.length === 1) {
					adapter.start = async () => {
						throw new Error("start failed");
					};
					const dispose = adapter.dispose.bind(adapter);
					adapter.dispose = async () => {
						disposing.resolve();
						await release.promise;
						await dispose();
					};
				}
				return adapter;
			};
			return { factory, disposing: disposing.promise, releaseDispose: () => release.resolve() };
		}

		it("joins the failure when the attach was still in its index lookup as the failed start claimed the file", async () => {
			const lookupOfC = deferred();
			const { factory, disposing, releaseDispose } = failingFirst();
			sessions = new SessionManager({ index: canonicalisingToC(lookupOfC.promise), adapters: { pi: factory } }, broadcaster);

			const throughC = sessions.attach(C);
			await settle();
			const throughRef = sessions.attach(REF);
			await disposing;
			lookupOfC.resolve();
			await settle();
			await settle();

			expect(factory.created).toHaveLength(1);
			expect(factory.created[0]?.disposed).toBe(false);

			releaseDispose();
			await expect(throughRef).rejects.toThrow("start failed");
			await expect(throughC).rejects.toThrow();
			expect(factory.created).toHaveLength(1);
			expect(sessions.liveRefs()).toEqual([]);
		});

		it("joins the failure when the attach arrives under a spelling the index canonicalises to the failed file", async () => {
			const { factory, disposing, releaseDispose } = failingFirst();
			sessions = new SessionManager({ index: canonicalisingToC(), adapters: { pi: factory } }, broadcaster);

			const throughC = sessions.attach(C);
			await disposing;
			const throughRef = sessions.attach(REF);
			await settle();
			await settle();

			expect(factory.created).toHaveLength(1);
			expect(factory.created[0]?.disposed).toBe(false);

			releaseDispose();
			await expect(throughC).rejects.toThrow("start failed");
			await expect(throughRef).rejects.toThrow();
			expect(factory.created).toHaveLength(1);
			expect(sessions.liveRefs()).toEqual([]);
		});

		it("joins the failure when the attach arrives under the canonical name a failed alias's start claimed", async () => {
			// C was never asked for: the failed startup holds it only because its
			// container was named by it (`#bind`).
			const { factory, disposing, releaseDispose } = failingFirst();
			sessions = new SessionManager({ index: canonicalisingToC(), adapters: { pi: factory } }, broadcaster);

			const throughRef = sessions.attach(REF);
			await disposing;
			const throughC = sessions.attach(C);
			await settle();
			await settle();

			expect(factory.created).toHaveLength(1);
			expect(factory.created[0]?.disposed).toBe(false);

			releaseDispose();
			await expect(throughRef).rejects.toThrow("start failed");
			await expect(throughC).rejects.toThrow();
			expect(factory.created).toHaveLength(1);
			expect(sessions.liveRefs()).toEqual([]);
		});
	});

	it("starts afresh for an attach that follows a close of a session whose start outlives its disposal", async () => {
		// The fake's `dispose()` does not release `holdStart`, so the closed
		// startup is still unsettled when the next attach arrives.
		const gate = deferred();
		const slow = new FakeAdapterFactory({ holdStart: gate.promise });
		sessions = new SessionManager({ index, adapters: { pi: slow } }, broadcaster);

		const first = sessions.attach(REF);
		await settle();
		await sessions.close(REF);
		const second = sessions.attach(REF);
		gate.resolve();

		await expect(first).rejects.toBeInstanceOf(UnknownSessionError);
		expect(await second).toBe(slow.created[1]);
		expect(sessions.isAttached(REF)).toBe(true);
	});

	it("resolves shutdown only once a close has disposed the adapter that was starting", async () => {
		// `disposeAll()` resolving is the server's licence to exit, and a close
		// still inside the kill's grace has not finished letting go.
		const gate = deferred();
		const slow = new FakeAdapterFactory({ holdStart: gate.promise });
		sessions = new SessionManager({ index, adapters: { pi: slow } }, broadcaster);
		const ref = sessions.createVirtual(WORKSPACE, "pi");
		const attaching = sessions.attach(ref);
		await settle();
		const adapter = slow.created[0];
		if (!adapter) throw new Error("no adapter");
		const release = holdDispose(adapter);

		const closing = sessions.close(ref);
		let shutDown = false;
		const shutdown = sessions.disposeAll().then(() => {
			shutDown = true;
		});
		await settle();
		await settle();

		expect(shutDown).toBe(false);

		release();
		await shutdown;
		await closing;
		expect(adapter.disposed).toBe(true);
		gate.resolve();
		await expect(attaching).rejects.toThrow();
	});

	it("disposes an adapter once when shutdown lands between its publication and its attach's return", async () => {
		// `attach` announces the list change once `#start` has published the
		// adapter and before it returns, so a client that shuts the server down
		// on hearing it lands in exactly that window.
		let shutdown: Promise<void> | undefined;
		broadcaster.addClient((chunk) => {
			if (!shutdown && chunk.includes('"type":"sessions-changed"')) shutdown = sessions.disposeAll();
		});

		await sessions.attach(REF);
		expect(shutdown).toBeDefined();
		await shutdown;

		expect(pi.created).toHaveLength(1);
		expect(pi.created[0]?.disposals).toBe(1);
	});
});

/**
 * OW-furinu. The list's order is `updatedAt`, which only a re-list carries, so
 * the turn boundaries have to say so. Two per turn -- deliberately not one per
 * token, which would put the whole corpus back through the sort on every
 * streaming frame (OW-jineli).
 */
describe("turn boundaries", () => {
	function collectEvents(): ServerEvent[] {
		const events: ServerEvent[] = [];
		broadcaster.addClient((chunk) => {
			for (const line of chunk.split("\n")) {
				if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as ServerEvent);
			}
		});
		return events;
	}

	it("relist the session list at both ends of a turn, and not per token", async () => {
		await sessions.attach(REF);
		const events = collectEvents();
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");

		adapter.append(userMessage("hello"));
		adapter.setStreaming(true);
		adapter.streamToken("a");
		adapter.streamToken("b");

		expect(events.filter((event) => event.type === "sessions-changed")).toHaveLength(1);

		adapter.setStreaming(false);

		expect(events.filter((event) => event.type === "sessions-changed")).toHaveLength(2);
	});

	it("reports a streaming flip with no message changed as status, not a snapshot, at both ends of a turn (OW-yirosu)", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");
		adapter.messages = [userMessage("hello")];
		const events = collectEvents();

		adapter.setStreaming(true);
		expect(events).toEqual([expect.objectContaining({ type: "status", isStreaming: true }), { type: "sessions-changed" }]);

		events.length = 0;
		adapter.setStreaming(false);
		expect(events).toEqual([expect.objectContaining({ type: "status", isStreaming: false }), { type: "sessions-changed" }]);
	});

	it("sends a message index that flipped isStreaming as an upsert then a status, as Claude's turn start is (OW-yirosu)", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");
		const events = collectEvents();

		// `beginTurn`: the prompt's index, with isStreaming already true.
		adapter.messages = [userMessage("hello")];
		adapter.setStreaming(true, 0);

		expect(events).toEqual([
			expect.objectContaining({ type: "upsert", index: 0 }),
			expect.objectContaining({ type: "status", isStreaming: true }),
			{ type: "sessions-changed" },
		]);
	});

	it("sends nothing for a status-only update that moved nothing (OW-yirosu)", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");
		const events = collectEvents();

		adapter.emitStatus();

		expect(events).toEqual([]);
	});

	it("still snapshots an update that replaced the transcript (OW-yirosu)", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");
		const events = collectEvents();

		adapter.messages = [userMessage("rewound")];
		adapter.emitTranscriptReplaced();

		expect(events).toEqual([
			expect.objectContaining({ type: "snapshot", messages: [expect.objectContaining({ role: "user" })] }),
		]);
	});

	it("reports a compaction flip with no message changed as status (OW-yirosu)", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");
		const events = collectEvents();

		adapter.setCompaction("running");

		expect(events).toEqual([expect.objectContaining({ type: "status", compaction: "running" })]);
	});

	it("announces the error a prompt's admission cleared, with no snapshot, so every client drops it (OW-jopifu)", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");
		adapter.emitError("turn failed");
		const events = collectEvents();

		await sessions.submit(REF, "again");

		expect(events).toEqual([expect.objectContaining({ type: "error-cleared", session: REF })]);
	});

	it("announces nothing for a session closed while the prompt was being admitted (OW-jopifu)", async () => {
		let entered!: () => void;
		const admitting = new Promise<void>((resolve) => (entered = resolve));
		let admit!: () => void;
		const admitted = new Promise<void>((resolve) => (admit = resolve));
		const gated = new FakeAdapterFactory({
			onSubmit: () => {
				entered();
				return admitted;
			},
		});
		sessions = new SessionManager({ index, adapters: { pi: gated } }, broadcaster);
		await sessions.attach(REF);
		const handle = sessions.summaryOf(REF)?.handle ?? "";
		gated.forRef(REF)!.emitError("turn failed");
		const submitted = sessions.submit(REF, "again").catch(() => {});
		await admitting;
		await sessions.close(REF);
		const events = collectEvents();

		admit();
		await submitted;

		expect(events).toEqual([]);
		// Nor does anything re-create the counter the close forgot.
		expect(broadcaster.seqOf(handle)).toBe(0);
	});

	it("sends neither a snapshot nor a clear for a prompt's admission when no error was held (OW-yirosu, OW-jopifu)", async () => {
		await sessions.attach(REF);
		const events = collectEvents();

		await sessions.submit(REF, "hello");

		expect(events.filter((event) => event.type === "snapshot" || event.type === "error-cleared")).toEqual([]);
	});

	it("broadcasts an atomic compaction marker and terminal state as one snapshot", async () => {
		await sessions.attach(REF);
		const events = collectEvents();
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");

		adapter.setCompaction("running");
		events.length = 0;
		adapter.messages = [{ role: "compactionSummary", summary: "", tokensBefore: 10, timestamp: 1 }];
		adapter.setCompaction(null, 0);

		expect(events).toEqual([
			expect.objectContaining({
				type: "snapshot",
				messages: [expect.objectContaining({ role: "compactionSummary" })],
				compaction: null,
			}),
		]);
	});

	it("broadcasts a successful model change as status without repainting the transcript", async () => {
		await sessions.attach(REF);
		const events = collectEvents();
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");

		await adapter.setModel("opaque/accepted");

		expect(events).toEqual([
			expect.objectContaining({
				type: "status",
				model: "opaque/accepted",
			}),
		]);
	});

	it("broadcasts an effort change as status, as it does a model change (OW-kokalo)", async () => {
		await sessions.attach(REF);
		const events = collectEvents();
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");

		await adapter.setEffort("low");

		expect(events).toEqual([expect.objectContaining({ type: "status", effort: "low" })]);
	});

	it("carries the recorded model a resume could not restore on status and snapshot, and its clearing (OW-jitoni)", async () => {
		await sessions.attach(REF);
		const events = collectEvents();
		const adapter = pi.forRef(REF);
		if (!adapter) throw new Error("no adapter");

		adapter.model = "openrouter/fallback";
		adapter.unrestoredModel = "openrouter/recorded";
		adapter.emitStatus();
		adapter.messages = [userMessage("hello")];
		adapter.emitTranscriptReplaced();
		adapter.unrestoredModel = undefined;
		adapter.emitStatus();

		expect(events).toEqual([
			expect.objectContaining({ type: "status", model: "openrouter/fallback", unrestoredModel: "openrouter/recorded" }),
			expect.objectContaining({ type: "snapshot", model: "openrouter/fallback", unrestoredModel: "openrouter/recorded" }),
			// Nothing else changed, so only this status says it cleared.
			expect.objectContaining({ type: "status", model: "openrouter/fallback", unrestoredModel: null }),
		]);
	});

	it("carries a recorded model the resume could not restore on the attach snapshot, before any turn (OW-jitoni)", async () => {
		const resumed = new FakeAdapterFactory({
			onStart: (adapter) => {
				adapter.model = "openrouter/fallback";
				adapter.unrestoredModel = "openrouter/recorded";
			},
		});
		const manager = new SessionManager({ index, adapters: { pi: resumed } }, broadcaster);
		const events = collectEvents();

		await manager.attach(REF);

		expect(events.filter((event) => event.type === "snapshot")).toEqual([
			expect.objectContaining({ type: "snapshot", session: REF, model: "openrouter/fallback", unrestoredModel: "openrouter/recorded" }),
		]);
	});
});

describe("re-attaching a thread a live app-server still holds (OW-voyezi)", () => {
	// The window OW-lajehi opened: a Codex fork borrows its parent's
	// `codex app-server`, so closing one side of the pair leaves the other side's
	// thread locked to a child nobody on agentpane's side is holding any more.
	// As of `codex-cli` 0.154.0 nothing releases that lock short of the child
	// dying -- `thread/unsubscribe` answers `unsubscribed` and changes nothing
	// (`docs/MANUAL_TESTING.md`, "`thread/unsubscribe` does not release a Codex
	// thread's writer lock") -- so a re-attach that spawned would be refused.
	//
	// The real `CodexAdapterFactory` drives these, against a fake app-server
	// cluster that enforces that lock: with `FakeAdapter` the sequence cannot
	// fail, and a test that cannot fail measures nothing.
	const parentRef: SessionRef = { backend: "codex", id: "thread-parent" };
	const forkRef: SessionRef = { backend: "codex", id: "thread-forked" };

	/** One fake app-server. Its kill releases every thread it was holding. */
	class LockingProcess extends FakeCodexProcess implements CodexProcess {
		readonly #errorAware: ((code: number | null, signal: string | null, error?: Error) => void)[] =
			[];

		constructor(private readonly release: (proc: LockingProcess) => void) {
			super();
		}

		override onExit(
			cb: (code: number | null, signal: string | null, error?: Error) => void,
		): void {
			this.#errorAware.push(cb);
		}

		override kill(): Promise<void> {
			this.release(this);
			for (const handler of [...this.#errorAware]) handler(0, null);
			return super.kill();
		}
	}

	/**
	 * `codex app-server` reduced to the one rule this is about: a thread belongs
	 * to the process that opened it, and a second process asking to resume it is
	 * refused with `-32600 already has an active writer` -- measured on the home
	 * server, 2026-09-15, `codex-cli 0.154.0`.
	 */
	class FakeCodexCluster {
		readonly procs: LockingProcess[] = [];
		readonly #locks = new Map<string, LockingProcess>();
		#forks = 0;
		#starts = 0;

		spawn = (): CodexProcess => {
			const proc = new LockingProcess((dead) => {
				for (const [threadId, holder] of this.#locks) {
					if (holder === dead) this.#locks.delete(threadId);
				}
			});
			this.procs.push(proc);
			proc.onWrite((message) => {
				const id = message["id"];
				if (typeof id !== "number") return;
				const params = (message["params"] ?? {}) as Record<string, unknown>;
				switch (message["method"]) {
					case "initialize":
						proc.emit({ id, result: { userAgent: "test" } });
						break;
					case "thread/resume": {
						const threadId = String(params["threadId"]);
						const holder = this.#locks.get(threadId);
						if (holder && holder !== proc) {
							proc.emit({
								id,
								error: { code: -32600, message: `thread ${threadId} already has an active writer` },
							});
							break;
						}
						this.#locks.set(threadId, proc);
						proc.emit({ id, result: { thread: { id: threadId, turns: [] }, model: "m" } });
						break;
					}
					case "thread/start": {
						// Nothing is on disk until a first turn (OW-hojefo), but the
						// process that started the thread holds it all the same.
						this.#starts += 1;
						const threadId = `thread-fresh-${this.#starts}`;
						this.#locks.set(threadId, proc);
						proc.emit({ id, result: { thread: { id: threadId, turns: [] }, model: "m" } });
						break;
					}
					case "thread/turns/list":
						proc.emit({
							id,
							result: { data: [{ id: "turn-1", items: [] }, { id: "turn-2", items: [] }], nextCursor: null, backwardsCursor: null },
						});
						break;
					case "thread/fork": {
						this.#forks += 1;
						const threadId = this.#forks === 1 ? forkRef.id : `${forkRef.id}-${this.#forks}`;
						this.#locks.set(threadId, proc);
						proc.emit({ id, result: { thread: { id: threadId, turns: [] } } });
						break;
					}
				}
			});
			return proc;
		};
	}

	let cluster: FakeCodexCluster;

	beforeEach(() => {
		cluster = new FakeCodexCluster();
		index = new FakeSessionIndex([
			storedSession(parentRef, WORKSPACE),
			// Codex flushes the forked rollout at `thread/fork`, so the index can
			// answer for the fork too -- which is exactly what sends a re-attach
			// down the factory path.
			storedSession(forkRef, WORKSPACE),
		]);
		sessions = new SessionManager(
			{ index, adapters: { codex: new CodexAdapterFactory({ spawn: cluster.spawn, codexRoot: join(tmpdir(), "agentpane-codex-no-store") }) } },
			broadcaster,
		);
	});

	async function attachedPair(): Promise<void> {
		await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "turn-2");
		expect(forked).toEqual(forkRef);
		await sessions.attach(forked);
		expect(cluster.procs).toHaveLength(1);
	}

	it("re-attaches the parent on the child its fork is still holding", async () => {
		await attachedPair();
		await sessions.close(parentRef);

		await expect(sessions.attach(parentRef)).resolves.toBeDefined();

		expect(cluster.procs).toHaveLength(1);
		expect(sessions.liveRefs().map(sessionKey).sort()).toEqual(
			[sessionKey(parentRef), sessionKey(forkRef)].sort(),
		);
	});

	it("re-attaches the fork on the child its parent is still holding", async () => {
		await attachedPair();
		await sessions.close(forkRef);

		await expect(sessions.attach(forkRef)).resolves.toBeDefined();

		expect(cluster.procs).toHaveLength(1);
		expect(sessions.liveRefs().map(sessionKey).sort()).toEqual(
			[sessionKey(parentRef), sessionKey(forkRef)].sort(),
		);
	});

	it("opens a fork that keeps no turn as a fresh thread on a child of its own (OW-hojefo)", async () => {
		await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "turn-1");

		// No `thread/fork` keeps nothing, so nothing is minted until the attach,
		// and the placeholder is renamed to the thread `thread/start` names, as a
		// virtual session's is (D9).
		expect(forked.id).toMatch(/^virtual:/);
		expect(cluster.procs[0]?.lastRequest("thread/fork")).toBeUndefined();
		const adapter = await sessions.attach(forked);

		expect(cluster.procs).toHaveLength(2);
		expect(adapter.ref).toEqual({ backend: "codex", id: "thread-fresh-1" });
		expect(sessions.liveRefs().map(sessionKey).sort()).toEqual(
			[sessionKey(parentRef), sessionKey(adapter.ref)].sort(),
		);
	});

	it("spawns again once the last holder has killed the child", async () => {
		await attachedPair();
		await sessions.close(parentRef);
		await sessions.close(forkRef);

		// Nothing holds the threads now, so borrowing the dead child would be the
		// worse bug: every request on it would go unanswered.
		await expect(sessions.attach(parentRef)).resolves.toBeDefined();
		expect(cluster.procs).toHaveLength(2);
	});
});

/**
 * The server holds each session's error and notices, and every snapshot
 * carries them (OW-bipume): the snapshot is the only thing that introduces a
 * session to a client, so a client that was not holding a view when one of
 * them was fanned out learns of it nowhere else.
 */
describe("what a snapshot tells a client that arrives late (OW-bipume)", () => {
	const notice = { kind: "configWarning", message: "unknown key", details: null, path: "/c.toml:3:5" };

	/** A client connecting now: its opening snapshots, then whatever is fanned out. */
	function connect(): ServerEvent[] {
		const events: ServerEvent[] = [];
		const client = broadcaster.addClient((chunk) => {
			for (const line of chunk.split("\n")) {
				if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as ServerEvent);
			}
		});
		broadcaster.sendOpeningSnapshots(client, sessions.liveHandles());
		return events;
	}

	const snapshots = (events: ServerEvent[]) =>
		events.filter((event): event is Extract<ServerEvent, { type: "snapshot" }> => event.type === "snapshot");

	it("carries the turn error and the notices raised before the client connected", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF)!;
		adapter.emitError("turn failed");
		adapter.emitNotice(notice);

		expect(snapshots(connect())).toEqual([
			expect.objectContaining({ session: REF, error: "turn failed", notices: [notice] }),
		]);
	});

	it("carries what the adapter raised inside start(), before the session was published", async () => {
		const raising = new FakeAdapterFactory({
			onStart: (adapter) => {
				adapter.emitError("resume failed halfway");
				adapter.emitNotice(notice);
			},
		});
		sessions = new SessionManager({ index, adapters: { pi: raising } }, broadcaster);
		const early = connect();

		await sessions.attach(REF);

		// The client connected before the attach and held no view while the two
		// were fanned out; the attach's snapshot is the first it hears of them.
		expect(snapshots(early)).toEqual([
			expect.objectContaining({
				session: REF,
				error: "resume failed halfway",
				notices: [notice],
			}),
		]);
		expect(snapshots(connect())).toEqual([expect.objectContaining({ error: "resume failed halfway", notices: [notice] })]);
	});

	it("holds and fans out a notice the adapter repeats only once (OW-piloni)", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF)!;
		const other = { ...notice, message: "another key" };
		const events = connect();

		adapter.emitNotice(notice);
		adapter.emitNotice({ ...notice });
		adapter.emitNotice(other);

		expect(events.filter((event) => event.type === "notice")).toEqual([
			expect.objectContaining({ session: REF, notice }),
			expect.objectContaining({ session: REF, notice: other }),
		]);
		expect(snapshots(connect())[0]?.notices).toEqual([notice, other]);
	});

	it("carries the error naming a request the Codex adapter declined at arrival (OW-zisumi)", async () => {
		// The real adapter, since what is under test is that its own decline
		// reaches the table: a `FakeAdapter` would only replay what it was told.
		const ref: SessionRef = { backend: "codex", id: "thread-declining" };
		const proc = new FakeCodexProcess();
		proc.onWrite((message) => {
			const id = message["id"];
			if (typeof id !== "number") return;
			if (message["method"] === "initialize") proc.emit({ id, result: { userAgent: "test" } });
			if (message["method"] === "thread/resume") proc.emit({ id, result: { thread: { id: ref.id, turns: [] }, model: "m" } });
			if (message["method"] === "thread/turns/list") proc.emit({ id, result: { data: [], nextCursor: null, backwardsCursor: null } });
		});
		index = new FakeSessionIndex([storedSession(ref, WORKSPACE)]);
		const codex = new CodexAdapterFactory({ spawn: () => proc, codexRoot: join(tmpdir(), "agentpane-codex-no-store") });
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(ref);

		proc.emit({
			id: 9,
			method: "item/fileChange/requestApproval",
			params: { threadId: ref.id, turnId: "turn-1", itemId: "item-1" },
		});

		expect(proc.written).toContainEqual({ id: 9, result: { decision: "decline" } });
		expect(snapshots(connect())).toEqual([
			expect.objectContaining({ session: ref, error: expect.stringContaining("item/fileChange/requestApproval") }),
		]);
	});

	it("clears the error when the next prompt is admitted (OW-31)", async () => {
		await sessions.attach(REF);
		pi.forRef(REF)!.emitError("turn failed");

		await sessions.submit(REF, "again");

		expect(snapshots(connect())[0]?.error).toBeNull();
	});

	it("keeps an error raised while that prompt was being admitted", async () => {
		const raising = new FakeAdapterFactory({ onSubmit: (adapter) => adapter.emitError("refused at admission") });
		sessions = new SessionManager({ index, adapters: { pi: raising } }, broadcaster);
		await sessions.attach(REF);
		raising.forRef(REF)!.emitError("turn failed");
		const events = connect();

		await sessions.submit(REF, "again");

		expect(snapshots(connect())[0]?.error).toBe("refused at admission");
		// Nor tells any client to drop an error the server still holds (OW-jopifu).
		expect(events.filter((event) => event.type === "error-cleared")).toEqual([]);
	});

	it("keeps an error raised while that prompt was being admitted even when its text matches the one held (OW-lameke)", async () => {
		// A steer's round trip, say, inside which the running turn fails the same
		// way the last one did: Pi and Codex both handle backend events while
		// `submit()` awaits its reply.
		const raising = new FakeAdapterFactory({ onSubmit: (adapter) => adapter.emitError("turn failed") });
		sessions = new SessionManager({ index, adapters: { pi: raising } }, broadcaster);
		await sessions.attach(REF);
		raising.forRef(REF)!.emitError("turn failed");
		const events = connect();

		await sessions.submit(REF, "again");

		expect(snapshots(connect())[0]?.error).toBe("turn failed");
		expect(events.filter((event) => event.type === "error-cleared")).toEqual([]);
	});

	it("keeps the error when the prompt is refused", async () => {
		const refusing = new FakeAdapterFactory({
			onSubmit: () => {
				throw new Error("busy");
			},
		});
		sessions = new SessionManager({ index, adapters: { pi: refusing } }, broadcaster);
		await sessions.attach(REF);
		refusing.forRef(REF)!.emitError("turn failed");

		await expect(sessions.submit(REF, "again")).rejects.toThrow("busy");
		expect(snapshots(connect())[0]?.error).toBe("turn failed");
	});

	it("clears the error a client dismissed", async () => {
		await sessions.attach(REF);
		pi.forRef(REF)!.emitError("turn failed");

		sessions.clearError(REF, sessions.errorIdOf(REF)!);

		expect(snapshots(connect())[0]?.error).toBeNull();
	});

	it("keeps an error newer than the one a client dismissed", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF)!;
		adapter.emitError("first turn failed");
		const first = sessions.errorIdOf(REF)!;
		adapter.emitError("second turn failed");

		sessions.clearError(REF, first);

		expect(snapshots(connect())[0]?.error).toBe("second turn failed");
	});

	it("keeps a newer error than the one a client dismissed even when its text matches (OW-jokoto)", async () => {
		await sessions.attach(REF);
		const events = connect();
		const adapter = pi.forRef(REF)!;
		adapter.emitError("The turn ended in an error.");
		// The client showed this one, as its event named it, and its dismissal is
		// on its way when the next turn fails word for word the same.
		const shown = events.find((event): event is Extract<ServerEvent, { type: "error" }> => event.type === "error")!;
		adapter.emitError("The turn ended in an error.");

		sessions.clearError(REF, shown.errorId);

		const [held] = snapshots(connect());
		expect(held?.error).toBe("The turn ended in an error.");
		expect(held?.errorId).not.toBe(shown.errorId);
		expect(events.filter((event) => event.type === "error-cleared")).toEqual([]);
	});

	it("clears no error a restarted server raised for the id of one the first server raised (OW-jokoto)", async () => {
		// A buffer or a tab outlives the restart holding the first process's id,
		// and the second process's first error must not answer to it.
		await sessions.attach(REF);
		pi.forRef(REF)!.emitError("extension failed to load");
		const held = sessions.errorIdOf(REF)!;
		const restartedPi = new FakeAdapterFactory();
		const restarted = new SessionManager({ index, adapters: { pi: restartedPi } }, new Broadcaster());
		await restarted.attach(REF);
		restartedPi.forRef(REF)!.emitError("extension failed to load");
		const raised = restarted.errorIdOf(REF);

		await restarted.submit(REF, "again", undefined, held);
		expect(restarted.errorIdOf(REF)).toBe(raised);
		restarted.clearError(REF, held);
		expect(restarted.errorIdOf(REF)).toBe(raised);
		expect(raised).not.toBeNull();
	});

	it("announces a dismissal it honoured to every client, with no snapshot (OW-jopifu)", async () => {
		await sessions.attach(REF);
		pi.forRef(REF)!.emitError("turn failed");
		const events = connect();

		sessions.clearError(REF, sessions.errorIdOf(REF)!);

		expect(events.slice(1)).toEqual([expect.objectContaining({ type: "error-cleared", session: REF })]);
	});

	it("announces nothing for a dismissal naming an error it no longer holds (OW-jopifu)", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF)!;
		adapter.emitError("first turn failed");
		const first = sessions.errorIdOf(REF)!;
		adapter.emitError("second turn failed");
		const events = connect();

		sessions.clearError(REF, first);

		expect(events.slice(1)).toEqual([]);
	});

	it("carries both across a rename", async () => {
		const REAL = "/home/u/.pi/agent/sessions/materialised.jsonl";
		const renaming = new FakeAdapterFactory({
			materialiseOnSubmit: REAL,
			onSubmit: (adapter) => adapter.emitError("turn failed"),
		});
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi");
		await sessions.attach(virtualRef);
		const adapter = renaming.forRef(virtualRef)!;
		adapter.emitNotice(notice);
		const events = connect();

		await sessions.submit(virtualRef, "first");

		// The snapshot the rename broadcasts under the handle, carrying the new ref.
		expect(snapshots(events).at(-1)).toEqual(
			expect.objectContaining({ session: { backend: "pi", id: REAL }, error: "turn failed", notices: [notice] }),
		);
	});

	it("leaves the parent's turn error behind on a fork that moves the container, and keeps what the process holds", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF)!;
		adapter.emitError("parent turn failed");
		adapter.emitNotice(notice);

		const forked = await sessions.fork(REF, "e1");

		expect(snapshots(connect())).toEqual([
			expect.objectContaining({ session: forked, error: null, notices: [notice] }),
		]);
	});

	it("holds nothing for a session re-attached after a close", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF)!;
		adapter.emitError("turn failed");
		adapter.emitNotice(notice);

		await sessions.close(REF);
		await sessions.attach(REF);

		expect(snapshots(connect())).toEqual([expect.objectContaining({ error: null, notices: [] })]);
	});
});

describe("a session's mutations run one at a time (D24, OW-sewewe)", () => {
	type Verb = "setModel" | "setEffort" | "fork";

	/**
	 * Park each call of the three verbs at the adapter until the test settles
	 * it, logging when each call begins at the adapter and when it settles. The
	 * fake's default fork mode is Pi's, which moves the adapter's ref.
	 */
	function holdVerbs(adapter: FakeAdapter) {
		const log: string[] = [];
		const gates: { resolve: () => void; reject: (error: Error) => void }[] = [];
		for (const verb of ["setModel", "setEffort", "fork"] as const) {
			const original = adapter[verb].bind(adapter) as (arg: string) => Promise<unknown>;
			(adapter as unknown as Record<Verb, (arg: string) => Promise<unknown>>)[verb] = async (arg) => {
				log.push(`begin ${verb}`);
				try {
					await new Promise<void>((resolve, reject) => gates.push({ resolve, reject }));
					return await original(arg);
				} finally {
					log.push(`end ${verb}`);
				}
			};
		}
		return { log, gates };
	}

	async function flush(): Promise<void> {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	}

	async function attachHeld(forkMode?: "codex") {
		pi = new FakeAdapterFactory({
			models: [{ id: "m", label: "M", efforts: [{ id: "high", description: "High" }], defaultEffort: "high" }],
			...(forkMode ? { forkMode } : {}),
		});
		sessions = new SessionManager({ index, adapters: { pi } }, broadcaster);
		await sessions.attach(REF);
		const adapter = pi.forRef(REF)!;
		adapter.model = "m";
		return holdVerbs(adapter);
	}

	const call: Record<Verb, () => Promise<unknown>> = {
		setModel: () => sessions.setModel(REF, "m"),
		setEffort: () => sessions.setEffort(REF, "high"),
		fork: () => sessions.fork(REF, "e1"),
	};

	it.each([
		["setModel", "setEffort"],
		["setEffort", "setModel"],
		["fork", "setModel"],
		["setModel", "fork"],
	] as const)("begins %s, then %s at the adapter only once the first has settled", async (first, second) => {
		// A verb queued on a Pi parent behind its fork never reaches the adapter
		// at all (below), so a fork that goes first is one that moves no ref.
		const { log, gates } = await attachHeld(first === "fork" ? "codex" : undefined);

		const one = call[first]();
		const two = call[second]();
		await flush();
		expect(log).toEqual([`begin ${first}`]);

		gates[0]?.resolve();
		await one;
		await flush();
		expect(log).toEqual([`begin ${first}`, `end ${first}`, `begin ${second}`]);

		gates[1]?.resolve();
		await two;
		expect(log).toEqual([`begin ${first}`, `end ${first}`, `begin ${second}`, `end ${second}`]);
	});

	it.each(["setModel", "submit"] as const)(
		"rejects a %s queued on a Pi parent's ref behind its fork, and never reaches the fork's adapter",
		async (verb) => {
			// The fork takes the parent's adapter onto a container of its own, and
			// the queue stays with the parent's, which keeps none (OW-suyinu).
			const { log, gates } = await attachHeld();
			const adapter = pi.forRef(REF)!;

			const forking = call.fork();
			const queued = verb === "setModel" ? sessions.setModel(REF, "m") : sessions.submit(REF, "hi");
			await flush();
			gates[0]?.resolve();
			await forking;
			await flush();

			expect(log).toEqual(["begin fork", "end fork"]);
			expect(adapter.prompts).toEqual([]);
			await expect(queued).rejects.toBeInstanceOf(UnknownSessionError);
		},
	);

	it("runs a verb on a Pi fork's ref only once the fork that moved the adapter has settled", async () => {
		// `PiAdapter.fork` announces the move, then re-sends the model and level
		// and hydrates the fork before it returns, all inside the fork verb. The
		// fork's ref resolves from the announcement on, so a verb on it must
		// queue behind that tail: the queue follows the adapter (OW-woyifu,
		// OW-dutute).
		await sessions.attach(REF);
		const adapter = pi.forRef(REF)!;
		const log: string[] = [];
		const moved = deferred();
		const tail = deferred();
		const fork = adapter.fork.bind(adapter);
		adapter.fork = async (entryId) => {
			const forked = await fork(entryId);
			log.push("fork tail begin");
			moved.resolve();
			await tail.promise;
			log.push("fork tail end");
			return forked;
		};
		const setModel = adapter.setModel.bind(adapter);
		adapter.setModel = async (model) => {
			log.push("setModel");
			await setModel(model);
		};

		const forking = sessions.fork(REF, "e1");
		await moved.promise;
		const setting = sessions.setModel({ backend: "pi", id: `${REF.id}#fork-e1` }, "m");
		await flush();
		tail.resolve();
		await forking;
		await setting;

		expect(log).toEqual(["fork tail begin", "fork tail end", "setModel"]);
	});

	it("runs the next verb after one that rejects", async () => {
		const { log, gates } = await attachHeld();

		const one = call.setModel();
		const two = call.setEffort();
		await flush();
		gates[0]?.reject(new Error("set_model failed"));
		await expect(one).rejects.toThrow("set_model failed");
		await flush();
		expect(log).toEqual(["begin setModel", "end setModel", "begin setEffort"]);

		gates[1]?.resolve();
		await expect(two).resolves.toBeUndefined();
	});
});
