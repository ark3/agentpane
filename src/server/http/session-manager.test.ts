/**
 * Process-table edges that are awkward to provoke through the socket:
 * concurrent attaches, a spawn that fails, and the bookkeeping that must not
 * outlive a session.
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
import { BackendRefusedError } from "../adapters/types.ts";
import { Broadcaster } from "./broadcaster.ts";
import {
	AtCapacityError,
	AttachedNotPromptedError,
	ForkNotPromptedError,
	HandleEndedError,
	NotAForkPointError,
	SessionManager,
	StartTimeoutError,
	UnknownBackendError,
	UnknownSessionError,
	idleTimeoutMs,
	maxSessions,
	reapFloor,
	startTimeoutMs,
} from "./session-manager.ts";
import type { SessionIndex } from "./deps.ts";
import {
	deferred,
	type FakeAdapter,
	FakeAdapterFactory,
	type FakeAdapterOptions,
	FakeSessionIndex,
	FakeSharedChild,
	FakeTimers,
	storedSession,
	userMessage,
} from "./testing/fakes.ts";

const REF: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/a.jsonl" };
/** The ref `create` mints on a manager given `newId: () => "created"`. */
const CREATED: SessionRef = { backend: "pi", id: "virtual:created" };
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
	broadcaster.addClient((event) => events.push(event));
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

/** Attach `ref` and answer its live adapter, read back under the ref the attach answered. */
async function attachAdapter(ref: SessionRef): Promise<FakeAdapter> {
	const attached = await sessions.attach(ref);
	return sessions.adapterFor(attached.ref) as FakeAdapter;
}

/** Close the session `ref` names by its container's handle, as a client's close does (D35 point 3). */
function closeLive(ref: SessionRef): Promise<void> {
	const handle = sessions.summaryOf(ref)?.handle;
	if (handle === undefined) throw new Error(`no container under ${sessionKey(ref)}`);
	return sessions.close(handle);
}

describe("attach", () => {
	it("spawns once even when two attaches race", async () => {
		const [a, b] = await Promise.all([sessions.attach(REF), sessions.attach(REF)]);
		expect(a.handle).toBe(b.handle);
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
		const frames: ServerEvent[] = [];
		broadcaster.addClient((event) => frames.push(event));
		flaky.created[0]?.append(userMessage("ghost"));
		expect(frames).toEqual([]);

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
		await expect(sessions.create(WORKSPACE, "codex")).rejects.toBeInstanceOf(UnknownBackendError);
	});

	it("rejects a session no store knows about", async () => {
		await expect(sessions.attach({ backend: "pi", id: "/nope" })).rejects.toBeInstanceOf(
			UnknownSessionError,
		);
	});

	it("uses the index's canonical ref, and the requested spelling becomes no name (D35 point 1)", async () => {
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

		const attached = await sessions.attach(requested);

		expect(attached.ref).toEqual(canonical);
		expect(pi.createdFor).toEqual([canonical]);
		expect(pi.created[0]?.startOptions).toEqual({ cwd: WORKSPACE, resumeId: canonical.id });
		expect(sessions.adapterFor(canonical)).toBe(pi.created[0]);
		expect(sessions.summaryOf(canonical)?.handle).toBe(attached.handle);
		expect(sessions.summaryOf(requested)).toBeNull();
		expect(sessions.holds(requested)).toBe(false);
	});

	it("removes the canonical table entry when startup fails, leaving the requested spelling unknown", async () => {
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
		expect(sessions.holds(requested)).toBe(false);
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

		expect(throughAlias).toEqual(expect.objectContaining({ ref: canonical, handle: first.handle }));
		expect(pi.created).toHaveLength(1);
		expect(sessions.holds(alias)).toBe(false);
		expect(sessions.liveRefs()).toEqual([canonical]);
	});

	it("collapses concurrent distinct spellings at the arbitration after the index canonicalizes them (D35 point 5)", async () => {
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

		expect(second.handle).toBe(first.handle);
		expect(first.ref).toEqual(canonical);
		expect(pi.created).toHaveLength(1);
		expect(sessions.holds(aliasA)).toBe(false);
		expect(sessions.holds(aliasB)).toBe(false);
		expect(sessions.liveRefs()).toEqual([canonical]);
	});

	it("a failed canonical winner fails the spelling that joined it, and leaves no state", async () => {
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
		expect(sessions.holds(aliasA)).toBe(false);
		expect(sessions.holds(aliasB)).toBe(false);
		expect(sessions.adapterFor(canonical)).toBeUndefined();
		expect(sessions.liveRefs()).toEqual([]);
	});
});

describe("an adapter that renames itself (the Pi contract)", () => {
	// `PiAdapter.ref` is not stable at construction: Pi's session id IS its JSONL
	// path (D9), which Pi names from start()'s get_state, and a backend that has
	// named nothing by the end of attach names it at the first prompt instead. The
	// adapter announces each move through `onRefChanged` and the manager moves
	// the container's one name to the new id (D24, D35 point 1); these are that
	// contract.
	const REAL = "/home/u/.pi/agent/sessions/materialised.jsonl";

	it("adopts the id the adapter took during start()", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);

		const attached = await sessions.attach(REF);

		expect(sessions.liveRefs()).toEqual([{ backend: "pi", id: REAL }]);
		// The summary an attach's reply carries is a client's other way of
		// learning the new id, so it must not still carry the index's stale one.
		expect(attached.ref).toEqual({ backend: "pi", id: REAL });
		expect(attached.preview).toBe("hello");
		// The id it outgrew reaches nothing (D35 point 1). A stored Pi session
		// is not renamed at its resume (`pi 1.5.2`, docs/BACKENDS.md "Resume"),
		// so the second row the index would list for REF is not met in use.
		expect(sessions.summaryOf(REF)).toBeNull();
	});

	it("adopts the id a virtual session takes on its first prompt when attach named none (D9)", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnSubmit: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const created = await sessions.create(WORKSPACE, "pi");
		expect(created.ref.id).toMatch(/^virtual:/);

		await sessions.submit(created.ref, "first", undefined, undefined, created.handle);

		const real: SessionRef = { backend: "pi", id: REAL };
		expect(sessions.summaryOf(real)?.handle).toBe(created.handle);
		expect(sessions.liveRefs()).toEqual([real]);
		expect(sessions.holds(created.ref)).toBe(false);
		// A session listed under a `virtual:` id it no longer has is a session the
		// browser can never find on disk again.
		const listed = await sessions.list();
		expect(listed.map((s) => s.ref.id)).not.toContain(created.ref.id);
	});

	it("closes a renamed session by its handle, leaving neither id resolving", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const { handle } = await sessions.attach(REF);

		await sessions.close(handle);

		expect(sessions.liveRefs()).toEqual([]);
		expect(sessions.holds(REF)).toBe(false);
		expect(sessions.holds({ backend: "pi", id: REAL })).toBe(false);
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
		const created = await sessions.create(WORKSPACE, "claude");
		const minted: SessionRef = { backend: "claude", id: "minted" };
		// The create answers the id the start renamed it to (D35 point 1).
		expect(created.ref).toEqual(minted);
		const { handle } = created;
		const adapter = sessions.adapterFor(minted);
		const events = broadcastEvents();

		await sessions.submit(minted, "hi");
		proc.emit({ type: "system", subtype: "init", session_id: "cli-chosen" });

		const chosen: SessionRef = { backend: "claude", id: "cli-chosen" };
		expect(naming(chosen, events)).toEqual([expect.objectContaining({ type: "snapshot", handle })]);
		expect(sessions.liveRefs()).toEqual([chosen]);
		expect(sessions.adapterFor(chosen)).toBe(adapter);
		expect(sessions.adapterFor(minted)).toBeUndefined();
	});

	describe("a rename announced inside start()", () => {
		// All three adapters rename a created session there. The container is
		// keyed by its handle and carries the startup itself, so its name moves to
		// the new id at once and reaches that startup; only the wire waits for the
		// adapter to be published (D35 point 1).
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

		it("moves the name at once, and an attach under it joins the one startup", async () => {
			const { factory, wire, attaching, release } = await attachParkedAfterRename();

			expect(sessions.holds(REF)).toBe(false);
			const handle = sessions.summaryOf(real)?.handle;
			expect(handle).toBeDefined();
			const joining = sessions.attach(real);
			// Held for the publish: a start that still fails must leave nothing.
			expect(wire).toEqual([]);

			release();
			expect((await joining).handle).toBe((await attaching).handle);
			expect(factory.created).toHaveLength(1);
			// Said once, by the attach, and under the handle.
			expect(wire.map((event) => event.type)).toEqual(["sessions-changed", "snapshot"]);
			expect(wire[1]).toMatchObject({ session: real, handle });
			expect(sessions.liveRefs()).toEqual([real]);
		});

		it("sends what the adapter emits during start under the new ref", async () => {
			const { wire, release, attaching } = await attachParkedAfterRename((adapter) => adapter.append(userMessage("hello")));

			expect(wire).toEqual([expect.objectContaining({ type: "upsert", session: real, index: 0 })]);
			release();
			await attaching;
			expect(naming(REF, wire)).toEqual([]);
		});

		it("leaves no rename and nothing on the wire behind when start() then fails", async () => {
			const factory = renamingInsideStart(async () => {
				throw new Error("get_messages failed");
			});
			sessions = new SessionManager({ index, adapters: { pi: factory } }, broadcaster);
			const wire = broadcastEvents();

			await expect(sessions.attach(REF)).rejects.toThrow("get_messages failed");

			expect(wire).toEqual([]);
			expect(sessions.holds(REF)).toBe(false);
			expect(sessions.summaryOf(real)).toBeNull();
			expect(sessions.liveRefs()).toEqual([]);
			// A container left in the table would list a row of its own.
			expect((await sessions.list()).map((summary) => summary.ref)).toEqual([REF]);
		});

		it("refuses an attach and a prompt by the virtual id a create's start renamed, spawning nothing (D35 point 1)", async () => {
			// No index entry has a `virtual:` id, so an outgrown one reaches nothing.
			const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
			sessions = new SessionManager({ index, adapters: { pi: renaming }, newId: () => "created" }, broadcaster);
			const created = await sessions.create(WORKSPACE, "pi");
			expect(created.ref).toEqual(real);

			await expect(sessions.attach(CREATED)).rejects.toBeInstanceOf(UnknownSessionError);
			await expect(sessions.attachAndSubmit(CREATED, "hi", undefined, null)).rejects.toBeInstanceOf(UnknownSessionError);

			expect(sessions.holds(CREATED)).toBe(false);
			expect(renaming.created).toHaveLength(1);
			expect(renaming.created[0]?.prompts).toEqual([]);
		});

		it("takes a created container out under the name its failed start moved it to (D30)", async () => {
			const factory = renamingInsideStart(async () => {
				throw new Error("get_messages failed");
			});
			sessions = new SessionManager({ index, adapters: { pi: factory }, newId: () => "created" }, broadcaster);

			await expect(sessions.create(WORKSPACE, "pi")).rejects.toThrow("get_messages failed");

			for (const name of [CREATED, real]) {
				expect(sessions.summaryOf(name)).toBeNull();
				expect(sessions.holds(name)).toBe(false);
			}
			expect((await sessions.list()).map((summary) => summary.ref)).toEqual([REF]);
		});
	});
});

describe("create (D30)", () => {
	it("starts the session's agent and answers its live summary, under the virtual ref it minted", async () => {
		const created = await sessions.create(WORKSPACE, "pi");

		expect(created.ref.id).toMatch(/^virtual:/);
		expect(created).toEqual(expect.objectContaining({ status: "attached", onDisk: false }));
		expect(pi.created).toHaveLength(1);
		expect(sessions.summaryOf(created.ref)?.handle).toBe(created.handle);
	});

	it("leaves no container, no name and no row when the start fails, and says so to a client that listed it", async () => {
		const gate = deferred();
		const flaky = new FakeAdapterFactory({ holdStart: gate.promise, failStart: "sbox: no git root" });
		sessions = new SessionManager({ index, adapters: { pi: flaky }, newId: () => "created" }, broadcaster);
		const creating = sessions.create(WORKSPACE, "pi");
		await settle();
		const events = broadcastEvents();

		gate.resolve();
		await expect(creating).rejects.toThrow("sbox: no git root");

		expect(sessions.summaryOf(CREATED)).toBeNull();
		expect(sessions.holds(CREATED)).toBe(false);
		expect(sessions.liveHandles()).toEqual([]);
		expect((await sessions.list()).map((summary) => summary.ref)).toEqual([REF]);
		expect(events).toContainEqual(expect.objectContaining({ type: "sessions-changed" }));
		// No name: an attach under the minted ref finds nothing to start.
		await expect(sessions.attach(CREATED)).rejects.toBeInstanceOf(UnknownSessionError);
		expect(flaky.created).toHaveLength(1);
		expect(flaky.created[0]?.disposals).toBe(1);
	});
});

describe("fork, which moves the live adapter's ref on Pi alone", () => {
	// The backends are asymmetric (settled live, MANUAL_TESTING.md OW-pifowo):
	// only Pi's adapter announces a `"fork"` -- Claude Code's fork leaves its
	// own ref alone, as Codex's does (OW-razoki) -- and SessionManager.fork
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
		expect(sessions.holds(codexRef)).toBe(true);
		expect(sessions.liveRefs()).toEqual([codexRef]);
		expect(events.filter((event) => "session" in event && sessionKey(event.session) !== sessionKey(codexRef))).toEqual([]);
	});

	// Claude Code's shape (OW-razoki): `fork()` mints the fork's id and the
	// arguments that spawn its child, but runs nothing. Nothing has written the
	// fork's store file yet, so the session index cannot answer for it -- the
	// manager hands that recipe to the fork's own start (D35 point 6).
	it("starts and attaches a fork the session index has never heard of, from the recipe its adapter returned", async () => {
		const claudeRef: SessionRef = { backend: "claude", id: "parent" };
		const claude = new FakeAdapterFactory({ forkMode: "claude" });
		index = new FakeSessionIndex([storedSession(claudeRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		await sessions.attach(claudeRef);
		const parent = sessions.adapterFor(claudeRef);

		const forked = await sessions.fork(claudeRef, "e1");

		expect(forked).toEqual({ backend: "claude", id: "parent#fork-e1" });
		// The parent is untouched: same ref, same live adapter.
		expect(sessions.holds(claudeRef)).toBe(true);
		expect(sessions.adapterFor(claudeRef)).toBe(parent);
		expect(sessions.adapterFor(forked)).not.toBe(parent);
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

	it("leaves nothing when the fork's start fails, so an attach by its ref finds nothing to start", async () => {
		// As a create's failed start leaves nothing (D30, D35 point 6): nothing
		// holds the recipe past the one start it was handed to.
		const claudeRef: SessionRef = { backend: "claude", id: "parent" };
		// One options object every adapter the factory builds reads, so the
		// fork's start can fail without the parent's having failed.
		const options: FakeAdapterOptions = { forkMode: "claude" };
		const claude = new FakeAdapterFactory(options);
		index = new FakeSessionIndex([storedSession(claudeRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		await sessions.attach(claudeRef);

		options.failStart = "fork refused";
		await expect(sessions.fork(claudeRef, "e1")).rejects.toThrow("fork refused");
		delete options.failStart;
		const forked: SessionRef = { backend: "claude", id: "parent#fork-e1" };

		expect(sessions.holds(forked)).toBe(false);
		await expect(sessions.attach(forked)).rejects.toBeInstanceOf(UnknownSessionError);
		expect(claude.created).toHaveLength(2);
		expect(claude.created[1]?.disposals).toBe(1);
	});

	// What a ref-changing fork leaves behind for the PARENT (OW-kekoji). The
	// adapter genuinely moves -- the one live adapter is driving the fork now,
	// from a container of the fork's own -- but the parent is a second
	// conversation, not an older name for this one, so its name does not go
	// with it and the parent's ref stops resolving at all.
	// It is detached, in the sense D9 and D12 already define, and the next
	// attach rehydrates it. Pi is the only backend that reaches this
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
		expect(sessions.holds(REF)).toBe(false);
		expect(sessions.summaryOf(REF)).toBeNull();
	});

	describe("what the adapter emits from inside a ref-changing fork (OW-zovaye)", () => {
		// `PiAdapter.fork` moves its ref onto the fork, then re-reads the fork's
		// rewound transcript and emits it -- all before `fork()` returns. The
		// adapter announces the move first (`onRefChanged`), so the container is
		// under the fork's ref before anything is emitted; otherwise it goes out
		// under the PARENT's ref, and every client showing the parent redraws it
		// shortened.
		const moved: SessionRef = { backend: "pi", id: `${REF.id}#fork-e1` };

		function collectEvents(): ServerEvent[] {
			const events: ServerEvent[] = [];
			broadcaster.addClient((event) => events.push(event));
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
			// The window beside the emits above: the adapter has moved onto the fork
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
			const client = broadcaster.addClient((event) => events.push(event));
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
		// over would have `summaryOf` dress it in the fork's ref. The parent is
		// listed too (OW-kekoji), so the attach response would draw the fork's
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

	it("refuses a close of the parent's handle after a Pi fork, and leaves the fork's live adapter alone", async () => {
		// The parent's handle ended at the fork, so a client still holding it
		// is refused, and the agent the fork is driving lives on.
		await sessions.attach(REF);
		const parentAdapter = pi.forRef(REF);
		const parentHandle = sessions.summaryOf(REF)!.handle;

		const forked = await sessions.fork(REF, "e1");
		await expect(sessions.close(parentHandle)).rejects.toBeInstanceOf(HandleEndedError);

		expect(parentAdapter?.disposed).toBe(false);
		expect(sessions.isAttached(forked)).toBe(true);
		expect(sessions.liveRefs()).toEqual([forked]);
	});

	it("puts no fork's container into the table for a session closed while its fork was in flight", async () => {
		// `sessions/close` and `sessions/forkAndPrompt` each run as their frame arrives
		// (socket.ts), and a close does not queue behind a fork
		// (`SessionManager.#serially`); nothing serializes them. `close()` empties the
		// table before its first await, and the adapter announces its move long
		// afterwards -- here, once Pi's gated fork round trip resumes. Were the
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
		await closeLive(REF);
		gate.resolve();
		const forked = await forking;

		expect(adapter.disposed).toBe(true);
		expect(sessions.liveRefs()).toEqual([]);
		expect(sessions.isAttached(forked)).toBe(false);
	});

	it("puts no fork's container into the table for a session disposed while its fork was in flight", async () => {
		// Same window as the test above, with shutdown in place of the close.
		// `disposeAll()` clears the table before its first await, and the gated
		// `fork` announces its move afterwards -- so were each ManagedSession not
		// unsubscribed in that same run, it would re-insert the disposed
		// container under the fork's id, into the table shutdown just emptied.
		// `liveRefs()` then hands that dead session to a browser reconnecting
		// mid-shutdown, and `isAttached()`/`adapterFor()` hand out its
		// disposed adapter to the commands on it.
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

	it("rejects a fork on a session with no live adapter", async () => {
		await expect(sessions.fork({ backend: "pi", id: "/nope" }, "e1")).rejects.toBeInstanceOf(
			UnknownSessionError,
		);
	});
});

describe("fork and prompt, one operation (D30)", () => {
	const POINTS = [
		{ id: "e1", text: "first", index: 0 },
		{ id: "e3", text: "second", index: 2 },
	];
	const IMAGES = [{ mimeType: "image/png", base64: "AAAA" }];

	/** A manager whose one backend, under `backend`, builds every adapter from `options`. */
	function managing(backend: "pi" | "codex" | "claude", options: FakeAdapterOptions): { ref: SessionRef } {
		const ref: SessionRef = backend === "pi" ? REF : { backend, id: "parent" };
		index = new FakeSessionIndex([storedSession(ref, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { [backend]: new FakeAdapterFactory(options) } }, broadcaster);
		return { ref };
	}

	// Codex's fork shape is "shared" (OW-lajehi); Claude Code's is the recipe.
	it.each([
		["claude", "claude"],
		["codex", "shared"],
	] as const)("forks a %s session (%s) at the point the index names, then attaches and prompts the fork, not the parent", async (backend, forkMode) => {
		const { ref } = managing(backend, { forkPoints: POINTS, forkMode });
		const parent = await attachAdapter(ref);

		const result = await sessions.forkAndPrompt(ref, 2, "again", IMAGES);

		const forkRef: SessionRef = { backend, id: "parent#fork-e3" };
		expect(parent.forks).toEqual(["e3"]);
		expect(parent.prompts).toEqual([]);
		expect((sessions.adapterFor(forkRef) as FakeAdapter).prompts).toEqual([{ text: "again", images: IMAGES }]);
		expect(result).toEqual({ session: sessions.summaryOf(forkRef), disposition: "started" });
		expect(result.session).toMatchObject({ ref: forkRef, status: "attached" });
		expect(result.session.handle).not.toBe(sessions.summaryOf(ref)?.handle);
	});

	it("forks a Pi session onto a container of its own and prompts it there", async () => {
		const { ref } = managing("pi", { forkPoints: POINTS });
		await sessions.attach(ref);
		const parentHandle = sessions.summaryOf(ref)?.handle;
		const adapter = sessions.adapterFor(ref) as FakeAdapter;

		const result = await sessions.forkAndPrompt(ref, 2, "again");

		const forkRef: SessionRef = { backend: "pi", id: `${REF.id}#fork-e3` };
		expect(adapter.forks).toEqual(["e3"]);
		expect(adapter.prompts).toEqual([{ text: "again", images: undefined }]);
		expect(result.session).toMatchObject({ ref: forkRef, status: "attached" });
		expect(result.session.handle).not.toBe(parentHandle);
		expect(sessions.isAttached(ref)).toBe(false);
	});

	it("answers a prompt the backend handled without a turn with that disposition", async () => {
		const { ref } = managing("claude", { forkPoints: POINTS, forkMode: "claude", onSubmit: () => "handled" });
		await sessions.attach(ref);

		await expect(sessions.forkAndPrompt(ref, 0, "/command")).resolves.toMatchObject({ disposition: "handled" });
	});

	it("lets no other client's prompt reach the adapter between a Pi fork's stop and the fork", async () => {
		const held = deferred();
		const log: string[] = [];
		const { ref } = managing("pi", { forkPoints: POINTS, onFork: () => held.promise });
		await sessions.attach(ref);
		const adapter = sessions.adapterFor(ref) as FakeAdapter;
		const abort = adapter.abort.bind(adapter);
		adapter.abort = async () => {
			log.push("stop");
			return abort();
		};
		const fork = adapter.fork.bind(adapter);
		adapter.fork = async (entryId) => {
			const forked = await fork(entryId);
			log.push("fork");
			return forked;
		};
		const submit = adapter.submit.bind(adapter);
		adapter.submit = async (text, images) => {
			log.push(`prompt ${text}`);
			return submit(text, images);
		};

		const editing = sessions.forkAndPrompt(ref, 2, "the edit");
		await settle();
		expect(log).toEqual(["stop"]);
		const other = sessions.submit(ref, "another client's prompt");
		await settle();
		held.resolve();

		await editing;
		// The other prompt was queued on the parent behind the operation, and the
		// fork took the adapter off the parent: it fails as a prompt to any
		// detached session does, and never reaches the fork (OW-suyinu).
		await expect(other).rejects.toBeInstanceOf(UnknownSessionError);
		expect(log).toEqual(["stop", "fork", "prompt the edit"]);
	});

	it("refuses an index no fork point names, and forks nothing (D20)", async () => {
		const { ref } = managing("codex", { forkPoints: POINTS, forkMode: "codex" });
		const parent = await attachAdapter(ref);

		await expect(sessions.forkAndPrompt(ref, 1, "again")).rejects.toBeInstanceOf(NotAForkPointError);
		expect(parent.forks).toEqual([]);
		expect(parent.prompts).toEqual([]);
		expect(sessions.liveRefs()).toEqual([ref]);
	});

	it("refuses a session with no live adapter, and forks nothing", async () => {
		const { ref } = managing("codex", { forkPoints: POINTS, forkMode: "codex" });

		await expect(sessions.forkAndPrompt(ref, 0, "again")).rejects.toBeInstanceOf(UnknownSessionError);
	});

	it("refuses a prompt the fork refused with an error naming the fork, and leaves the fork attached (D17)", async () => {
		const options: FakeAdapterOptions = { forkPoints: POINTS, forkMode: "claude" };
		const { ref } = managing("claude", options);
		await sessions.attach(ref);
		options.onSubmit = () => {
			throw new BackendRefusedError("not now");
		};

		const error = await sessions.forkAndPrompt(ref, 0, "again").catch((e: unknown) => e);

		const forkRef: SessionRef = { backend: "claude", id: "parent#fork-e1" };
		expect(error).toBeInstanceOf(ForkNotPromptedError);
		expect((error as ForkNotPromptedError).cause).toBeInstanceOf(BackendRefusedError);
		expect((error as ForkNotPromptedError).fork).toEqual({ ref: forkRef, handle: sessions.summaryOf(forkRef)?.handle });
		expect(sessions.isAttached(forkRef)).toBe(true);
		expect(sessions.isAttached(ref)).toBe(true);
	});

	it("refuses a fork whose own start failed with that failure alone, and leaves nothing a prompt by its ref can reach (D35 point 6)", async () => {
		const options: FakeAdapterOptions = { forkPoints: POINTS, forkMode: "claude" };
		const { ref } = managing("claude", options);
		await sessions.attach(ref);
		options.failStart = "fork would not start";

		const error = await sessions.forkAndPrompt(ref, 0, "again").catch((e: unknown) => e);
		delete options.failStart;

		// Named nowhere: each client stays on the parent with the edit open (D30).
		expect(error).not.toBeInstanceOf(ForkNotPromptedError);
		expect((error as Error).message).toBe("fork would not start");
		const forkRef: SessionRef = { backend: "claude", id: "parent#fork-e1" };
		expect(sessions.holds(forkRef)).toBe(false);
		await expect(sessions.attachAndSubmit(forkRef, "again", undefined, null)).rejects.toBeInstanceOf(UnknownSessionError);
		expect(sessions.liveRefs()).toEqual([ref]);
	});

	// `PiAdapter.fork` announces the move, then re-sends the level and hydrates
	// the fork, and either can reject: the parent's handle has ended by then,
	// and the fork is live under its own.
	it("refuses a Pi fork that fails after it moved with an error naming the fork live", async () => {
		const { ref } = managing("pi", { forkPoints: POINTS });
		await sessions.attach(ref);
		const parentHandle = sessions.summaryOf(ref)?.handle;
		const adapter = sessions.adapterFor(ref) as FakeAdapter;
		const fork = adapter.fork.bind(adapter);
		adapter.fork = async (entryId) => {
			await fork(entryId);
			throw new Error("set_thinking_level failed");
		};

		const error = await sessions.forkAndPrompt(ref, 2, "again").catch((e: unknown) => e);

		const forkRef: SessionRef = { backend: "pi", id: `${REF.id}#fork-e3` };
		expect(error).toBeInstanceOf(ForkNotPromptedError);
		expect((error as ForkNotPromptedError).message).toBe("set_thinking_level failed");
		expect((error as ForkNotPromptedError).fork).toEqual({ ref: forkRef, handle: sessions.summaryOf(forkRef)?.handle });
		expect((error as ForkNotPromptedError).fork.handle).not.toBe(parentHandle);
		expect(sessions.isAttached(forkRef)).toBe(true);
		expect(adapter.prompts).toEqual([]);
	});

	it("refuses a Pi fork that fails before it moved with that failure alone: nothing was forked", async () => {
		const { ref } = managing("pi", {
			forkPoints: POINTS,
			onFork: () => {
				throw new Error("fork failed");
			},
		});
		await sessions.attach(ref);

		const error = await sessions.forkAndPrompt(ref, 2, "again").catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(ForkNotPromptedError);
		expect((error as Error).message).toBe("fork failed");
		expect(sessions.liveRefs()).toEqual([ref]);
	});

	it("prompts a fork its start renamed, the Codex no-turn shape, and answers its renamed ref and handle (OW-hojefo, D35 point 1)", async () => {
		const options: FakeAdapterOptions = { forkPoints: POINTS, forkMode: "claude" };
		const { ref } = managing("codex", options);
		await sessions.attach(ref);
		// Read by the fork's start alone: the parent's has run.
		options.materialiseOnStart = "thread-fresh";

		const result = await sessions.forkAndPrompt(ref, 0, "again");

		const fresh: SessionRef = { backend: "codex", id: "thread-fresh" };
		expect(result).toEqual({ session: sessions.summaryOf(fresh), disposition: "started" });
		expect(result.session).toMatchObject({ ref: fresh, status: "attached" });
		expect((sessions.adapterFor(fresh) as FakeAdapter).prompts).toEqual([{ text: "again", images: undefined }]);
		expect(sessions.holds({ backend: "codex", id: "parent#fork-e1" })).toBe(false);
	});

	it("clears no error the fork's start raised: nobody has seen one on the fork (OW-jokoto)", async () => {
		const options: FakeAdapterOptions = { forkPoints: POINTS, forkMode: "claude" };
		const { ref } = managing("claude", options);
		await sessions.attach(ref);
		options.onStart = (adapter) => adapter.emitError("resumed with a warning");

		const { session } = await sessions.forkAndPrompt(ref, 0, "again");

		expect(sessions.errorIdOf(session.ref)).not.toBeNull();
	});
});

/** A prompt names the handle its sender holds live, or only the ref (D30). */
describe("a prompt names a handle or a ref (D30)", () => {
	it("prompts the live session under the handle it names", async () => {
		const adapter = await attachAdapter(REF);
		const handle = sessions.summaryOf(REF)!.handle;

		await expect(sessions.submit(REF, "hello", undefined, null, handle)).resolves.toBe("started");
		expect(adapter.prompts).toEqual([{ text: "hello", images: undefined }]);
	});

	it("refuses a handle that a close ended, though the session was attached again under another", async () => {
		await sessions.attach(REF);
		const ended = sessions.summaryOf(REF)!.handle;
		await closeLive(REF);
		const again = await attachAdapter(REF);
		expect(sessions.summaryOf(REF)!.handle).not.toBe(ended);

		await expect(sessions.submit(REF, "hello", undefined, null, ended)).rejects.toBeInstanceOf(HandleEndedError);
		expect(again.prompts).toEqual([]);
	});

	it("refuses a handle whose session a close took while its prompt waited in the queue", async () => {
		const held = deferred();
		pi = new FakeAdapterFactory({ onSubmit: (_adapter, text) => (text === "first" ? held.promise.then(() => undefined) : undefined) });
		sessions = new SessionManager({ index, adapters: { pi } }, broadcaster);
		const adapter = await attachAdapter(REF);
		const handle = sessions.summaryOf(REF)!.handle;

		const first = sessions.submit(REF, "first", undefined, null, handle);
		const second = sessions.submit(REF, "second", undefined, null, handle);
		await settle();
		const closing = closeLive(REF);
		held.resolve();

		await first;
		await expect(second).rejects.toBeInstanceOf(HandleEndedError);
		await closing;
		expect(adapter.prompts.map((prompt) => prompt.text)).toEqual(["first"]);
	});

	it("starts the session a prompt naming no handle is sent to, prompts it, and answers its live summary", async () => {
		const result = await sessions.attachAndSubmit(REF, "hello", undefined, null);

		const adapter = sessions.adapterFor(REF) as FakeAdapter;
		expect(pi.created).toHaveLength(1);
		expect(adapter.prompts).toEqual([{ text: "hello", images: undefined }]);
		expect(result).toEqual({ session: sessions.summaryOf(REF), disposition: "started" });
		expect(result.session.status).toBe("attached");
	});

	it("prompts a session already live when the prompt names no handle, starting nothing", async () => {
		const adapter = await attachAdapter(REF);

		await sessions.attachAndSubmit(REF, "hello", undefined, null);

		expect(pi.created).toHaveLength(1);
		expect(adapter.prompts).toEqual([{ text: "hello", images: undefined }]);
	});

	it("refuses a prompt refused after its attach with an error naming the session it attached", async () => {
		pi = new FakeAdapterFactory({
			onSubmit: () => {
				throw new BackendRefusedError("not now");
			},
		});
		sessions = new SessionManager({ index, adapters: { pi } }, broadcaster);

		const error = await sessions.attachAndSubmit(REF, "hello", undefined, null).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AttachedNotPromptedError);
		expect((error as AttachedNotPromptedError).cause).toBeInstanceOf(BackendRefusedError);
		expect((error as AttachedNotPromptedError).attached).toEqual({ ref: REF, handle: sessions.summaryOf(REF)?.handle });
		expect(sessions.isAttached(REF)).toBe(true);
	});

	it("refuses a prompt whose session would not start with that failure, naming nothing", async () => {
		pi = new FakeAdapterFactory({ failStart: "would not start" });
		sessions = new SessionManager({ index, adapters: { pi } }, broadcaster);

		const error = await sessions.attachAndSubmit(REF, "hello", undefined, null).catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(AttachedNotPromptedError);
		expect((error as Error).message).toBe("would not start");
		expect(sessions.isAttached(REF)).toBe(false);
	});
});

/**
 * The container is keyed by a handle the manager mints, and its current
 * backend id is its one name (D24, D35 point 1). A rename moves the
 * name; a fork is a new container with a new handle.
 */
describe("a container keyed by a handle", () => {
	const REAL = "/home/u/.pi/agent/sessions/materialised.jsonl";
	const handleOf = (ref: SessionRef) => sessions.summaryOf(ref)?.handle;

	// A browser tab and the Emacs helper outlive a server restart, and key their
	// live views by the handle (OW-kimaya), so a second process's first handle
	// must not be the first process's.
	it("mints a first handle no other manager mints, as a restarted server's would be", async () => {
		const restarted = new SessionManager({ index, adapters: { pi } }, new Broadcaster());
		const before = (await sessions.create(WORKSPACE, "pi")).handle;
		const after = (await restarted.create(WORKSPACE, "pi")).handle;
		expect(before).toEqual(expect.any(String));
		expect(after).toEqual(expect.any(String));
		expect(after).not.toBe(before);
	});

	it("gives a Pi-style fork a new handle and not the parent's name, and leaves the parent's ref resolving to nothing", async () => {
		const { handle: parentHandle } = await sessions.attach(REF);

		const forked = await sessions.fork(REF, "e1");

		const forkHandle = handleOf(forked);
		expect(forkHandle).toEqual(expect.any(String));
		expect(forkHandle).not.toBe(parentHandle);
		expect(sessions.summaryOf(REF)).toBeNull();
		expect(sessions.adapterFor(REF)).toBeUndefined();
		expect(sessions.liveHandles()).toEqual([forkHandle]);

		// Detached, so the next attach resumes the parent from the index into a
		// container of its own, and the fork's is untouched.
		const again = await sessions.attach(REF);
		expect(pi.created).toHaveLength(2);
		expect(again.handle).not.toBe(parentHandle);
		expect(again.handle).not.toBe(forkHandle);
		expect(handleOf(forked)).toBe(forkHandle);
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

		await closeLive(forked);
		const frames: ServerEvent[] = [];
		broadcaster.addClient((event) => frames.push(event));
		adapter.append(userMessage("after the close"));
		adapter.materialiseAs("/home/u/.pi/agent/sessions/after.jsonl");

		expect(frames).toEqual([]);
		expect(sessions.liveHandles()).toEqual([]);
		expect(sessions.summaryOf({ backend: "pi", id: "/home/u/.pi/agent/sessions/after.jsonl" })).toBeNull();
	});

	it("leaves a closed container reachable by neither its ref nor the one it outgrew", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const { handle } = await sessions.attach(REF);
		const real: SessionRef = { backend: "pi", id: REAL };

		await sessions.close(handle);

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

		const forkAdapter = sessions.adapterFor(forked) as FakeAdapter;

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
		const forkAdapter = sessions.adapterFor(forked) as FakeAdapter;

		await closeLive(parentRef);

		expect(child.kills).toBe(0);
		expect(child.holders).toBe(1);
		await sessions.submit(forked, "still here");
		expect(forkAdapter.prompts).toEqual([{ text: "still here", images: undefined }]);
	});

	it("keeps the parent driving the shared child after the fork is closed", async () => {
		const parent = await attachAdapter(parentRef);
		const forked = await sessions.fork(parentRef, "e1");

		await closeLive(forked);

		expect(child.kills).toBe(0);
		await sessions.submit(parentRef, "still here");
		expect(parent.prompts).toEqual([{ text: "still here", images: undefined }]);
	});

	it("kills the shared child exactly once when shutdown disposes both holders", async () => {
		await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "e1");

		await sessions.disposeAll();

		expect(child.holders).toBe(0);
		expect(child.kills).toBe(1);
	});

	it("disposes the fork's adapter exactly once when its own start fails, and the parent's shared child survives (D35 point 6)", async () => {
		// The startup's failure path reaps the adapter it claimed, as it reaps
		// any startup's, which releases the share; nothing else holds it.
		codex = new FakeAdapterFactory({
			forkMode: "shared",
			sharedChild: child,
			forkPoints: [{ id: "e1", text: "first", index: 0 }],
			forkOptions: { failStart: "fork refused" },
		});
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		const parent = await attachAdapter(parentRef);
		const forks = capturingForks();

		const error = await sessions.forkAndPrompt(parentRef, 0, "again").catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(ForkNotPromptedError);
		expect((error as Error).message).toBe("fork refused");
		expect(forks.built().disposals).toBe(1);
		// The share the failed borrower held is back, so the parent's child is
		// the parent's alone again, and still drives it.
		expect(child.holders).toBe(1);
		expect(child.kills).toBe(0);
		expect(sessions.holds(forkRef)).toBe(false);
		await sessions.submit(parentRef, "still here");
		expect(parent.prompts).toEqual([{ text: "still here", images: undefined }]);
		await closeLive(parentRef);
		expect(child.kills).toBe(1);
	});

	it("survives the parent being closed while the fork's start is in flight", async () => {
		// The interleaving the "share taken at fork time" decision exists to make
		// safe. `#disposing` is keyed per session, so `close(parent)` does not gate
		// the fork's start: without the share already held, the parent's release
		// would kill the child under the borrower's resume.
		const gate = deferred();
		codex = new FakeAdapterFactory({
			forkMode: "shared",
			sharedChild: child,
			forkOptions: { holdStart: gate.promise },
		});
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(parentRef);
		const forks = capturingForks();

		const forking = sessions.fork(parentRef, "e1");
		await forks.starting;
		await closeLive(parentRef);
		expect(child.kills).toBe(0);
		gate.resolve();

		expect(await forking).toEqual(forkRef);
		expect(forks.built().started).toBe(true);
		expect(child.holders).toBe(1);
		expect(child.kills).toBe(0);
		expect(sessions.liveRefs()).toEqual([forkRef]);
	});

	/**
	 * The adapter the parent's `fork()` builds, which the factory never sees,
	 * read once the fork has been taken; and when the fork's start has entered
	 * its `start()`, its startup having claimed it.
	 */
	function capturingForks(): { built: () => FakeAdapter; starting: Promise<void> } {
		const parent = codex.created[0];
		if (!parent) throw new Error("no parent adapter");
		const fork = parent.fork.bind(parent);
		const starting = deferred();
		let built: FakeAdapter | undefined;
		parent.fork = async (entryId) => {
			const forked = await fork(entryId);
			const adapter = forked.adapter as FakeAdapter;
			const start = adapter.start.bind(adapter);
			adapter.start = (options) => {
				starting.resolve();
				return start(options);
			};
			built = adapter;
			return forked;
		};
		return {
			built: () => {
				if (!built) throw new Error("no fork adapter");
				return built;
			},
			starting: starting.promise,
		};
	}

	it("disposes a starting fork's adapter once when shutdown lands during its start", async () => {
		const gate = deferred();
		codex = new FakeAdapterFactory({
			forkMode: "shared",
			sharedChild: child,
			forkOptions: { holdStart: gate.promise },
		});
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(parentRef);
		const forks = capturingForks();

		const forking = sessions.fork(parentRef, "e1");
		await forks.starting;
		await sessions.disposeAll();
		gate.resolve();
		await expect(forking).rejects.toThrow();

		expect(forks.built().disposals).toBe(1);
		expect(child.holders).toBe(0);
	});
});

describe("a backend that exits on its own (#97)", () => {
	const REPORT = "Pi process exited (code=1, signal=null)";

	/** The `ended` events among `events`. */
	function endedIn(events: ServerEvent[]): ServerEvent[] {
		return events.filter((event) => event.type === "ended");
	}

	it("lets a stored session whose child exits mid-turn go, saying why on its ended, and the next attach starts it again", async () => {
		const adapter = await attachAdapter(REF);
		const handle = sessions.summaryOf(REF)?.handle;
		adapter.setStreaming(true);
		const events = broadcastEvents();

		adapter.exit(REPORT);

		expect(endedIn(events)).toEqual([{ type: "ended", session: REF, handle, exit: REPORT }]);
		expect(events.filter((event) => event.type === "error")).toEqual([]);
		expect(sessions.isAttached(REF)).toBe(false);
		expect((await sessions.list()).find((s) => sessionKey(s.ref) === sessionKey(REF))?.status).toBe("detached");

		const again = await sessions.attach(REF);
		expect(pi.created).toHaveLength(2);
		expect(adapter.disposals).toBe(1);
		expect(sessions.adapterFor(again.ref)).toBe(pi.created[1]);
		expect(again.handle).not.toBe(handle);
	});

	it("sends no ended for an exit during start(), which stays the start's failure", async () => {
		const gate = deferred();
		const flaky = new FakeAdapterFactory({ holdStart: gate.promise, failStart: `${REPORT} before responding` });
		sessions = new SessionManager({ index, adapters: { pi: flaky } }, broadcaster);
		const events = broadcastEvents();
		const attaching = sessions.attach(REF);
		await settle();
		const adapter = flaky.created[0];
		if (!adapter) throw new Error("the start never built its adapter");

		adapter.exit(REPORT);
		gate.resolve();

		await expect(attaching).rejects.toThrow(`${REPORT} before responding`);
		expect(endedIn(events)).toEqual([]);
		expect(sessions.isAttached(REF)).toBe(false);
		expect(adapter.disposals).toBe(1);
	});

	it("lets a never-prompted session go with the report on its ended, leaving no row", async () => {
		sessions = new SessionManager({ index, adapters: { pi }, newId: () => "created" }, broadcaster);
		const created = await sessions.create(WORKSPACE, "pi");
		const events = broadcastEvents();

		pi.created[0]?.exit(REPORT);

		expect(endedIn(events)).toEqual([{ type: "ended", session: created.ref, handle: created.handle, exit: REPORT }]);
		expect(sessions.holds(created.ref)).toBe(false);
		expect((await sessions.list()).map((summary) => summary.ref)).toEqual([REF]);
	});

	it("lets the fork's session go after a Pi fork moved the adapter onto it", async () => {
		const adapter = await attachAdapter(REF);
		const forked = await sessions.fork(REF, "e1");
		const forkHandle = sessions.summaryOf(forked)?.handle;
		const events = broadcastEvents();

		adapter.exit(REPORT);

		expect(endedIn(events)).toEqual([{ type: "ended", session: forked, handle: forkHandle, exit: REPORT }]);
		expect(sessions.liveRefs()).toEqual([]);
	});

	it("sends each session on one shared child its own ended when that child exits", async () => {
		const parentRef: SessionRef = { backend: "codex", id: "thread-parent" };
		const child = new FakeSharedChild();
		const codex = new FakeAdapterFactory({ forkMode: "shared", sharedChild: child });
		index = new FakeSessionIndex([storedSession(parentRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		const parent = await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "e1");
		const fork = sessions.summaryOf(forked);
		const events = broadcastEvents();

		child.exit("codex app-server exited (code=1, signal=null)");

		expect(endedIn(events)).toEqual([
			{ type: "ended", session: parentRef, handle: parent.handle, exit: "codex app-server exited (code=1, signal=null)" },
			{ type: "ended", session: forked, handle: fork?.handle, exit: "codex app-server exited (code=1, signal=null)" },
		]);
		expect(sessions.liveRefs()).toEqual([]);
	});
});

describe("lifecycle", () => {
	it("keeps virtual sessions out of the backend store until prompted (D9)", async () => {
		const { ref } = await sessions.create(WORKSPACE, "pi", "pi-1");
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
		const created = await sessions.create(WORKSPACE, "pi", "openrouter/deepseek/deepseek-v4.1-flash:high");
		await sessions.submit(created.ref, "first", undefined, undefined, created.handle);
		await closeLive(real);

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
		await sessions.create(WORKSPACE, "pi");
		await sessions.create(WORKSPACE, "pi");

		await expect(sessions.disposeAll()).resolves.toBeUndefined();
		expect(brittle.created.map((c) => c.disposed)).toEqual([true, true]);
	});

	it("an explicit close survives an adapter that throws on dispose", async () => {
		const brittle = new FakeAdapterFactory({ failDispose: "kill: no such process" });
		sessions = new SessionManager({ index, adapters: { pi: brittle } }, broadcaster);
		await sessions.attach(REF);

		await expect(closeLive(REF)).resolves.toBeUndefined();
		expect(sessions.isAttached(REF)).toBe(false);
	});

	it("waits for a closing adapter to be disposed before attaching its replacement, once for two attaches (D32 point 5)", async () => {
		await sessions.attach(REF);
		const first = pi.created[0];
		if (!first) throw new Error("no adapter");
		const release = holdDispose(first);

		const closing = closeLive(REF);
		const attaches = [sessions.attach(REF), sessions.attach(REF)] as const;
		// Give an unguarded attach enough turns to reach the synchronous create().
		await settle();

		expect(pi.created).toHaveLength(1);

		release();
		await closing;
		const [a, b] = await Promise.all(attaches);
		expect(first.disposed).toBe(true);
		expect(pi.created).toHaveLength(2);
		expect(b.handle).toBe(a.handle);
	});

	it("says a close ended the handle, and that the list changed, before the adapter's disposal settles (D26, OW-sodohi)", async () => {
		// Up to the kill's grace passes between the forget and the disposal
		// settling, and a client that heard nothing meanwhile would hold a view
		// whose Send is refused `not_attached`.
		await sessions.attach(REF);
		const handle = sessions.summaryOf(REF)?.handle;
		const adapter = pi.created[0];
		if (!adapter) throw new Error("no adapter");
		const release = holdDispose(adapter);
		const events = broadcastEvents();

		const closing = closeLive(REF);
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

		const closing = closeLive(REF);
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

	it("refuses a second close of one handle while the first is disposing, and keeps the replacement waiting (OW-loromi)", async () => {
		// Two clients can each send the close. The second finds no live session
		// under the handle, as any close of an ended handle does, and leaves the
		// first's disposal holding the attach back.
		await sessions.attach(REF);
		const first = pi.created[0];
		if (!first) throw new Error("no adapter");
		const handle = sessions.summaryOf(REF)!.handle;
		const release = holdDispose(first);

		const closing = sessions.close(handle);
		await expect(sessions.close(handle)).rejects.toBeInstanceOf(HandleEndedError);
		const attaching = sessions.attach(REF);
		await settle();

		expect(pi.created).toHaveLength(1);
		expect(first.disposed).toBe(false);

		release();
		await closing;
		expect(first.disposals).toBe(1);
		expect(sessions.adapterFor((await attaching).ref)).toBe(pi.created[1]);
	});

	it("waits out a close under the canonical ref two unseen spellings' lookups name, and starts one replacement (D35 point 4)", async () => {
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

		const closing = closeLive(canonical);
		const throughAliasA = sessions.attach(aliasA);
		const throughAliasB = sessions.attach(aliasB);
		for (let i = 0; i < 4; i++) await Promise.resolve();

		expect(pi.created).toHaveLength(1);

		gate.resolve();
		await closing;
		const [replacementA, replacementB] = await Promise.all([throughAliasA, throughAliasB]);

		expect(first.disposed).toBe(true);
		expect(replacementB.handle).toBe(replacementA.handle);
		expect(replacementA.ref).toEqual(canonical);
		expect(pi.created).toHaveLength(2);
		expect(sessions.holds(aliasA)).toBe(false);
		expect(sessions.liveRefs()).toEqual([canonical]);
	});

	it("waits out a second close that began while an unseen spelling's lookup was in flight (D35 point 4)", async () => {
		const canonical: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/a.jsonl",
		};
		const alias: SessionRef = {
			backend: "pi",
			id: "/home/u/.pi/agent/sessions/ws/../ws/a.jsonl",
		};
		const summary = storedSession(canonical, WORKSPACE);
		const aliasLookup = deferred();
		const canonicalizingIndex: SessionIndex = {
			list: async () => [summary],
			get: async (ref) => {
				if (sessionKey(ref) === sessionKey(alias)) await aliasLookup.promise;
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
		const releaseFirst = holdDispose(first);

		const closingFirst = closeLive(canonical);
		const throughAlias = sessions.attach(alias);
		releaseFirst();
		await closingFirst;

		// Another attach and close of the file while the spelling's lookup is out.
		await sessions.attach(canonical);
		const second = pi.created[1];
		if (!second) throw new Error("no second adapter");
		const releaseSecond = holdDispose(second);
		const closingSecond = closeLive(canonical);

		aliasLookup.resolve();
		await settle();

		expect(pi.created).toHaveLength(2);

		releaseSecond();
		await closingSecond;
		const replacement = await throughAlias;

		expect(pi.created).toHaveLength(3);
		expect(replacement.ref).toEqual(canonical);
		expect(sessions.adapterFor(canonical)).toBe(pi.created[2]);
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
 * renames a new session at attach and writes nothing until the first turn,
 * and whether a fork has a file yet depends on the backend and the fork point
 * (D9). So the answer is the index's, and a fork starts without it.
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
		const created = await sessions.create(WORKSPACE, "pi");
		const real: SessionRef = { backend: "pi", id: REAL };
		expect(created.ref).toEqual(real);

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

describe("holds, what sessions/preview asks before it answers gone (D26 point 5)", () => {
	it("holds a container's ref in the table, and nothing it never heard of", async () => {
		const { ref } = await sessions.create(WORKSPACE, "pi");
		expect(sessions.holds(ref)).toBe(true);
		expect(sessions.holds(REF)).toBe(false);
	});

	it("does not hold a session whose close is still disposing it", async () => {
		const adapter = await attachAdapter(REF);
		const release = holdDispose(adapter);

		const closing = closeLive(REF);
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

	it("disposes an adapter that was still starting when the server shut down", async () => {
		const gate = deferred();
		const slow = new FakeAdapterFactory({ holdStart: gate.promise });
		sessions = new SessionManager({ index, adapters: { pi: slow }, newId: () => "created" }, broadcaster);
		const ref = CREATED;

		const attaching = sessions.create(WORKSPACE, "pi");
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

		const attaching = sessions.create(WORKSPACE, "pi");
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

	describe("an attach that waited out the close of a renamed session (OW-yufazo)", () => {
		// The session was attached as REF and renamed itself to C inside start(),
		// so the close's disposal sits under C alone (D35 point 4).
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
			const closing = closeLive(C);
			return { closing, releaseDispose, releaseLookup: () => lookup.resolve() };
		}

		it("resumes the ref the close was registered under once it is disposed, and the id it outgrew stays no name", async () => {
			const { closing, releaseDispose, releaseLookup } = await closeHeld();
			const attaching = sessions.attach(C);
			await settle();
			expect(pi.created).toHaveLength(1);

			releaseDispose();
			releaseLookup();
			await closing;
			const attached = await attaching;

			expect(pi.created).toHaveLength(2);
			expect(attached.ref).toEqual(C);
			expect(sessions.holds(REF)).toBe(false);
			await sessions.close(attached.handle);
			expect(sessions.liveRefs()).toEqual([]);
		});
	});

	describe("an attach whose file a failed start is still reaping (OW-kamave, D35 point 4)", () => {
		// The index resolves every ref to C. The first adapter's start fails and
		// its dispose is held, so its startup is reaping, its container out of
		// the table, while the other attach reaches C. Nothing joins a failed
		// start: the other attach waits the reaping out and starts afresh.
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

		it("waits out the reaping when the attach was still in its index lookup as the failed start failed, then spawns once", async () => {
			// The check after the lookup (D35 point 4): the wait in `#attach` ran
			// before the reaping began, so only the lookup's canonical ref finds it.
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
			const attached = await throughC;
			expect(factory.created).toHaveLength(2);
			expect(factory.created[0]?.disposals).toBe(1);
			expect(attached.ref).toEqual(C);
			expect(sessions.adapterFor(C)).toBe(factory.created[1]);
		});

		it("waits out the reaping when the attach arrives under a spelling the index canonicalises to the failed file, then spawns once", async () => {
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
			const attached = await throughRef;
			expect(factory.created).toHaveLength(2);
			expect(attached.ref).toEqual(C);
			expect(sessions.liveRefs()).toEqual([C]);
		});

		it("waits out the reaping when the attach arrives under the canonical ref a failed spelling's start claimed, then spawns once", async () => {
			// C was never asked for: the reaping is registered under it because the
			// failed start's container was claimed under it (D35 point 4).
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
			const attached = await throughC;
			expect(factory.created).toHaveLength(2);
			expect(factory.created[0]?.disposals).toBe(1);
			expect(attached.ref).toEqual(C);
			expect(sessions.adapterFor(C)).toBe(factory.created[1]);
		});
	});

	it("resolves a shutdown that lands during a failed start's reaping only once the reaping is done (D35 point 5)", async () => {
		const disposing = deferred();
		const release = deferred();
		const failing = new FakeAdapterFactory({ failStart: "start failed" });
		const create = failing.create.bind(failing);
		failing.create = (ref) => {
			const adapter = create(ref);
			const dispose = adapter.dispose.bind(adapter);
			adapter.dispose = async () => {
				disposing.resolve();
				await release.promise;
				await dispose();
			};
			return adapter;
		};
		sessions = new SessionManager({ index, adapters: { pi: failing } }, broadcaster);
		const attaching = sessions.attach(REF);
		await disposing.promise;

		let shutDown = false;
		const shutdown = sessions.disposeAll().then(() => {
			shutDown = true;
		});
		await settle();
		await settle();
		expect(shutDown).toBe(false);

		release.resolve();
		await shutdown;
		await expect(attaching).rejects.toThrow("start failed");
		expect(failing.created[0]?.disposals).toBe(1);
	});

	it("disposes an adapter once when shutdown lands between its publication and its attach's return", async () => {
		// `attach` announces the list change once `#start` has published the
		// adapter and before it returns, so a client that shuts the server down
		// on hearing it lands in exactly that window.
		let shutdown: Promise<void> | undefined;
		broadcaster.addClient((event) => {
			if (!shutdown && event.type === "sessions-changed") shutdown = sessions.disposeAll();
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
		broadcaster.addClient((event) => events.push(event));
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
		await closeLive(REF);
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

	it("carries only the status on status and snapshot, whatever else the adapter's state holds (#108)", async () => {
		const leak = { turnDiff: "diff" };
		const leaky = new FakeAdapterFactory({
			onStart: (adapter) => {
				const getState = adapter.getState.bind(adapter);
				adapter.getState = () => ({ ...getState(), ...leak });
			},
		});
		const manager = new SessionManager({ index, adapters: { pi: leaky } }, broadcaster);
		const events = collectEvents();

		await manager.attach(REF);
		const adapter = leaky.forRef(REF);
		if (!adapter) throw new Error("no adapter");
		adapter.setStreaming(true);
		adapter.emitTranscriptReplaced();

		const carried = events.filter((event) => event.type === "status" || event.type === "snapshot");
		expect(carried.map((event) => event.type)).toEqual(["snapshot", "status", "snapshot"]);
		for (const event of carried) expect(event).not.toHaveProperty("turnDiff");
	});
});

describe("re-attaching a thread a live app-server still holds (OW-voyezi)", () => {
	// The window a borrowed fork leaves (OW-lajehi): a Codex fork borrows its
	// parent's `codex app-server`, so closing one side of the pair leaves the
	// other side's thread locked to a child nobody on agentpane's side is holding any more.
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
						proc.emit({ id, result: { thread: { id: threadId, status: { type: "idle" }, turns: [] }, model: "m" } });
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
			// Codex flushes the forked rollout at `thread/fork` (as of `codex-cli`
			// 0.154.0, D9), so the index can answer for the fork too -- which is
			// exactly what sends a re-attach down the factory path.
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
		expect(cluster.procs).toHaveLength(1);
	}

	it("re-attaches the parent on the child its fork is still holding", async () => {
		await attachedPair();
		await closeLive(parentRef);

		await expect(sessions.attach(parentRef)).resolves.toBeDefined();

		expect(cluster.procs).toHaveLength(1);
		expect(sessions.liveRefs().map(sessionKey).sort()).toEqual(
			[sessionKey(parentRef), sessionKey(forkRef)].sort(),
		);
	});

	it("re-attaches the fork on the child its parent is still holding", async () => {
		await attachedPair();
		await closeLive(forkRef);

		await expect(sessions.attach(forkRef)).resolves.toBeDefined();

		expect(cluster.procs).toHaveLength(1);
		expect(sessions.liveRefs().map(sessionKey).sort()).toEqual(
			[sessionKey(parentRef), sessionKey(forkRef)].sort(),
		);
	});

	it("opens a fork that keeps no turn as a fresh thread on a child of its own (OW-hojefo)", async () => {
		await sessions.attach(parentRef);
		const forked = await sessions.fork(parentRef, "turn-1");

		// No `thread/fork` keeps nothing, so nothing is minted until the fork's
		// start, which renames its placeholder to the thread `thread/start` names,
		// as a virtual session's is (D9). The ref is read from the fork's
		// container, so it is the renamed one; the placeholder reaches nothing
		// (D35 point 1).
		expect(forked).toEqual({ backend: "codex", id: "thread-fresh-1" });
		expect(cluster.procs[0]?.lastRequest("thread/fork")).toBeUndefined();
		expect(cluster.procs).toHaveLength(2);
		expect(sessions.adapterFor(forked)?.ref).toEqual(forked);
		expect(sessions.liveRefs().map(sessionKey).sort()).toEqual(
			[sessionKey(parentRef), sessionKey(forked)].sort(),
		);
	});

	it("spawns again once the last holder has killed the child", async () => {
		await attachedPair();
		await closeLive(parentRef);
		await closeLive(forkRef);

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
		const client = broadcaster.addClient((event) => events.push(event));
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
			if (message["method"] === "thread/resume") proc.emit({ id, result: { thread: { id: ref.id, status: { type: "idle" }, turns: [] }, model: "m" } });
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
		const created = await sessions.create(WORKSPACE, "pi");
		const adapter = renaming.forRef(created.ref)!;
		adapter.emitNotice(notice);
		const events = connect();

		await sessions.submit(created.ref, "first", undefined, undefined, created.handle);

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

		await closeLive(REF);
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
		// queue behind that tail: the queue follows the adapter (OW-woyifu).
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

	it("steers a Codex prompt sent after the first's turn/start reply, once that turn's turn/started lands (D34 point 5)", async () => {
		// The real adapter, since what is under test is that its gate holds the
		// queue: `CodexAdapter.submit` answers only at `turn/started`.
		const ref: SessionRef = { backend: "codex", id: "thread-queued" };
		const proc = new FakeCodexProcess();
		proc.onWrite((message) => {
			const id = message["id"];
			if (typeof id !== "number") return;
			const method = message["method"];
			if (method === "initialize") proc.emit({ id, result: { userAgent: "test" } });
			if (method === "thread/resume") proc.emit({ id, result: { thread: { id: ref.id, status: { type: "idle" }, turns: [] }, model: "m" } });
			if (method === "thread/turns/list") proc.emit({ id, result: { data: [], nextCursor: null, backwardsCursor: null } });
			if (method === "turn/start") proc.emit({ id, result: { turn: { id: "turn-1" } } });
			if (method === "turn/steer") proc.emit({ id, result: { turnId: "turn-1" } });
		});
		index = new FakeSessionIndex([storedSession(ref, WORKSPACE)]);
		const codex = new CodexAdapterFactory({ spawn: () => proc, codexRoot: join(tmpdir(), "agentpane-codex-no-store") });
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(ref);

		const first = sessions.submit(ref, "first");
		await flush();
		expect(proc.lastRequest("turn/start")).toBeDefined();
		const second = sessions.submit(ref, "second");
		await flush();
		expect(proc.written.map((message) => message["method"])).not.toContain("turn/steer");

		proc.emit({
			method: "turn/started",
			params: {
				threadId: ref.id,
				turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
			},
		});
		await expect(first).resolves.toBe("started");
		await expect(second).resolves.toBe("started");

		expect(proc.written.filter((message) => message["method"] === "turn/start")).toHaveLength(1);
		expect(proc.lastRequest("turn/steer")?.["params"]).toMatchObject({ threadId: ref.id, expectedTurnId: "turn-1" });
	});
});

describe("the idle reaper (D12)", () => {
	/** Enough sessions, with `REF`, to bring the count to `reapFloor`. */
	const FILLERS: SessionRef[] = Array.from({ length: reapFloor - 1 }, (_, i) => ({
		backend: "pi",
		id: `/home/u/.pi/agent/sessions/filler-${i}.jsonl`,
	}));
	let timers: FakeTimers;

	// The fillers stream, so the reaper never closes them and their own clocks
	// stop at the run out here, leaving each test the clocks it starts.
	beforeEach(async () => {
		timers = new FakeTimers();
		index = new FakeSessionIndex([REF, ...FILLERS].map((ref) => storedSession(ref, WORKSPACE)));
		sessions = new SessionManager({ index, adapters: { pi }, newId: () => "created", setTimer: timers.set }, broadcaster);
		for (const ref of FILLERS) (await attachAdapter(ref)).setStreaming(true);
		timers.runOut();
		await settle();
	});

	it("closes nothing below the floor, and checks again an interval later", async () => {
		await sessions.attach(REF);
		await closeLive(FILLERS[0] as SessionRef);

		timers.runOut();
		await settle();
		expect(sessions.isAttached(REF)).toBe(true);
		expect(timers.pending).toEqual([idleTimeoutMs]);

		(await attachAdapter(FILLERS[0] as SessionRef)).setStreaming(true);
		timers.runOut();
		await settle();
		expect(sessions.isAttached(REF)).toBe(false);
	});

	it("closes an idle session, as a close does: ended, then sessions-changed", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF) as FakeAdapter;
		const handle = sessions.summaryOf(REF)?.handle;
		expect(timers.pending).toEqual([idleTimeoutMs]);
		const events = broadcastEvents();

		timers.runOut();
		await settle();

		expect(sessions.isAttached(REF)).toBe(false);
		expect(adapter.disposals).toBe(1);
		expect(events).toEqual([{ type: "ended", session: REF, handle }, { type: "sessions-changed" }]);
		expect(timers.pending).toEqual([]);
	});

	it("spares a streaming session, and counts its idleness from the turn's end", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF) as FakeAdapter;
		adapter.setStreaming(true);

		timers.runOut();
		await settle();
		expect(sessions.isAttached(REF)).toBe(true);
		expect(adapter.disposed).toBe(false);
		expect(timers.pending).toEqual([]);

		adapter.setStreaming(false);
		expect(timers.pending).toEqual([idleTimeoutMs]);
		timers.runOut();
		await settle();
		expect(sessions.isAttached(REF)).toBe(false);
	});

	it("spares a compacting session, and counts its idleness from the compaction's end", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF) as FakeAdapter;
		adapter.setCompaction("requesting");

		timers.runOut();
		await settle();
		expect(sessions.isAttached(REF)).toBe(true);
		expect(adapter.disposed).toBe(false);
		adapter.setCompaction("running");
		expect(timers.pending).toEqual([]);

		adapter.setCompaction(null);
		expect(timers.pending).toEqual([idleTimeoutMs]);
		timers.runOut();
		await settle();
		expect(sessions.isAttached(REF)).toBe(false);
	});

	it("spares a virtual session, and counts its idleness from its first prompt", async () => {
		await sessions.create(WORKSPACE, "pi");

		timers.runOut();
		await settle();
		expect(sessions.isAttached(CREATED)).toBe(true);

		const handle = sessions.summaryOf(CREATED)?.handle as string;
		await sessions.submit(CREATED, "hello", undefined, null, handle);
		expect(timers.pending).toEqual([idleTimeoutMs]);
		timers.runOut();
		await settle();
		expect(sessions.isAttached(CREATED)).toBe(false);
	});

	it("restarts the clock at an attach and a prompt, keeping one timer per session", async () => {
		await sessions.attach(REF);
		await sessions.attach(REF);
		expect(timers.pending).toEqual([idleTimeoutMs]);
		const handle = sessions.summaryOf(REF)?.handle as string;
		await sessions.submit(REF, "hello", undefined, null, handle);
		expect(timers.pending).toEqual([idleTimeoutMs]);
	});

	it("moves the clock onto a Pi fork's container, and reaps the fork by it", async () => {
		await sessions.attach(REF);
		const forked = await sessions.fork(REF, "e1");
		expect(timers.pending).toEqual([idleTimeoutMs]);

		timers.runOut();
		await settle();
		expect(sessions.isAttached(forked)).toBe(false);
		expect((pi.forRef(REF) as FakeAdapter).disposals).toBe(1);
	});

	it("spawns exactly once for a reaped session attached again by hand, once the reaped agent is gone", async () => {
		await sessions.attach(REF);
		const reaped = pi.forRef(REF) as FakeAdapter;
		const release = holdDispose(reaped);
		timers.runOut();

		const attaches = Promise.all([sessions.attach(REF), sessions.attach(REF)]);
		await settle();
		expect(pi.created).toHaveLength(FILLERS.length + 1);

		release();
		const [a, b] = await attaches;
		expect(a.handle).toBe(b.handle);
		expect(pi.created).toHaveLength(FILLERS.length + 2);
		expect(reaped.disposals).toBe(1);
		expect(sessions.isAttached(REF)).toBe(true);
	});

	it("leaves no timer behind a close or a shutdown", async () => {
		await sessions.attach(REF);
		await closeLive(REF);
		expect(timers.pending).toEqual([]);

		await sessions.attach(REF);
		await sessions.disposeAll();
		expect(timers.pending).toEqual([]);
	});
});

describe("a start's deadline (D35 point 2)", () => {
	let timers: FakeTimers;

	beforeEach(() => {
		timers = new FakeTimers();
	});

	it("refuses an attach whose start never resolves, reaping its adapter once and holding nothing", async () => {
		const hung = new FakeAdapterFactory({ holdStart: new Promise<void>(() => {}) });
		sessions = new SessionManager({ index, adapters: { pi: hung }, setTimer: timers.set }, broadcaster);

		const attaching = sessions.attach(REF);
		await settle();
		expect(timers.pending).toEqual([startTimeoutMs]);
		timers.runOut();

		await expect(attaching).rejects.toThrow(StartTimeoutError);
		expect(hung.created).toHaveLength(1);
		expect(hung.created[0]?.disposals).toBe(1);
		expect(sessions.holds(REF)).toBe(false);
		expect(sessions.liveHandles()).toEqual([]);
	});

	it("reaps a start that resolves after its deadline and never publishes it", async () => {
		const gate = deferred();
		const late = new FakeAdapterFactory({ holdStart: gate.promise });
		sessions = new SessionManager({ index, adapters: { pi: late }, setTimer: timers.set }, broadcaster);
		const events = broadcastEvents();

		const attaching = sessions.attach(REF);
		await settle();
		timers.runOut();
		gate.resolve();

		await expect(attaching).rejects.toThrow(StartTimeoutError);
		await settle();
		expect(late.created[0]?.started).toBe(true);
		expect(late.created[0]?.disposals).toBe(1);
		expect(sessions.liveHandles()).toEqual([]);
		expect(sessions.holds(REF)).toBe(false);
		expect(events.filter((event) => event.type === "snapshot")).toEqual([]);
	});

	it("cancels the deadline of a start that resolves in time", async () => {
		const gate = deferred();
		pi = new FakeAdapterFactory({ holdStart: gate.promise });
		sessions = new SessionManager({ index, adapters: { pi }, setTimer: timers.set }, broadcaster);

		const attaching = sessions.attach(REF);
		await settle();
		expect(timers.pending).toEqual([startTimeoutMs]);
		gate.resolve();
		await attaching;

		// Only D12's idle clock is left.
		expect(timers.pending).toEqual([idleTimeoutMs]);
	});
});

describe("the subprocess cap (D12)", () => {
	/** `maxSessions + 1` stored sessions, the last one the attach that passes the cap. */
	const STORED: SessionRef[] = Array.from({ length: maxSessions + 1 }, (_, i) => ({
		backend: "pi",
		id: `/home/u/.pi/agent/sessions/cap-${i}.jsonl`,
	}));
	const OVER = STORED[maxSessions] as SessionRef;

	beforeEach(() => {
		index = new FakeSessionIndex(STORED.map((ref) => storedSession(ref, WORKSPACE)));
		sessions = new SessionManager({ index, adapters: { pi }, newId: () => "created" }, broadcaster);
	});

	/** Attach the first `maxSessions` stored sessions, in order. */
	async function fill(): Promise<void> {
		for (const ref of STORED.slice(0, maxSessions)) await sessions.attach(ref);
	}

	it("closes the least recently attached eligible session before spawning past it", async () => {
		await fill();
		const [first, streaming, coldest] = STORED as [SessionRef, SessionRef, SessionRef];
		// Attached again, the first is no longer the coldest; streaming, the
		// second is exempt; so the third is the one to go.
		await sessions.attach(first);
		(pi.forRef(streaming) as FakeAdapter).setStreaming(true);
		const handle = sessions.summaryOf(coldest)?.handle;
		const events = broadcastEvents();

		await sessions.attach(OVER);

		expect(sessions.isAttached(coldest)).toBe(false);
		expect((pi.forRef(coldest) as FakeAdapter).disposals).toBe(1);
		expect(sessions.isAttached(first)).toBe(true);
		expect(sessions.isAttached(streaming)).toBe(true);
		expect(sessions.isAttached(OVER)).toBe(true);
		expect(sessions.liveRefs()).toHaveLength(maxSessions);
		expect(pi.created).toHaveLength(maxSessions + 1);
		expect(naming(coldest, events)).toEqual([{ type: "ended", session: coldest, handle }]);
	});

	it("refuses at once, spawning and closing nothing, when every session under it is exempt", async () => {
		for (const ref of STORED.slice(0, maxSessions - 1)) {
			await sessions.attach(ref);
			(pi.forRef(ref) as FakeAdapter).setStreaming(true);
		}
		await sessions.create(WORKSPACE, "pi");

		await expect(sessions.attach(OVER)).rejects.toThrow(AtCapacityError);

		expect(pi.created).toHaveLength(maxSessions);
		expect(pi.created.every((adapter) => !adapter.disposed)).toBe(true);
		expect(sessions.isAttached(OVER)).toBe(false);
		expect(sessions.holds(OVER)).toBe(false);
	});

	it("passes over a compacting session for the next eligible one", async () => {
		await fill();
		const [compacting, next] = STORED as [SessionRef, SessionRef];
		(pi.forRef(compacting) as FakeAdapter).setCompaction("running");

		await sessions.attach(OVER);

		expect(sessions.isAttached(compacting)).toBe(true);
		expect((pi.forRef(compacting) as FakeAdapter).disposed).toBe(false);
		expect(sessions.isAttached(next)).toBe(false);
		expect(sessions.isAttached(OVER)).toBe(true);
	});

	it("refuses at once when the one session not streaming is compacting", async () => {
		await fill();
		const [compacting, ...rest] = STORED.slice(0, maxSessions) as [SessionRef, ...SessionRef[]];
		(pi.forRef(compacting) as FakeAdapter).setCompaction("requesting");
		for (const ref of rest) (pi.forRef(ref) as FakeAdapter).setStreaming(true);

		await expect(sessions.attach(OVER)).rejects.toThrow(AtCapacityError);

		expect(pi.created).toHaveLength(maxSessions);
		expect(pi.created.every((adapter) => !adapter.disposed)).toBe(true);
	});

	it("counts a startup still in flight, which it cannot close", async () => {
		const held = deferred();
		const slow = new FakeAdapterFactory({ holdStart: held.promise });
		sessions = new SessionManager({ index, adapters: { pi: slow } }, broadcaster);
		const starts = STORED.slice(0, maxSessions).map((ref) => sessions.attach(ref));
		await settle();

		const over = sessions.attach(OVER).catch((err: unknown) => err);
		await settle();
		expect(slow.created).toHaveLength(maxSessions);

		held.resolve();
		await Promise.all(starts);
		expect(await over).toBeInstanceOf(AtCapacityError);
	});

	it("bounds a create and a prompt naming a ref as it bounds an attach, leaving nothing of either", async () => {
		for (const ref of STORED.slice(0, maxSessions)) {
			await sessions.attach(ref);
			(pi.forRef(ref) as FakeAdapter).setStreaming(true);
		}

		await expect(sessions.create(WORKSPACE, "pi")).rejects.toThrow(AtCapacityError);
		expect(sessions.holds(CREATED)).toBe(false);
		await expect(sessions.attachAndSubmit(OVER, "hello", undefined, null)).rejects.toThrow(AtCapacityError);
		expect(pi.created).toHaveLength(maxSessions);
	});

	it("bounds the fork a Claude Code fork-and-prompt starts, leaving nothing of it (D35 point 6)", async () => {
		const claudeRefs: SessionRef[] = STORED.map((ref) => ({ backend: "claude", id: ref.id }));
		const parent = claudeRefs[0] as SessionRef;
		const claude = new FakeAdapterFactory({ forkMode: "claude", forkPoints: [{ id: "e1", text: "hi", index: 0 }] });
		index = new FakeSessionIndex(claudeRefs.map((ref) => storedSession(ref, WORKSPACE)));
		sessions = new SessionManager({ index, adapters: { claude } }, broadcaster);
		for (const ref of claudeRefs.slice(0, maxSessions)) {
			await sessions.attach(ref);
			(claude.forRef(ref) as FakeAdapter).setStreaming(true);
		}
		const handle = sessions.summaryOf(parent)?.handle;

		const refused = await sessions.forkAndPrompt(parent, 0, "again", undefined, handle).catch((err: unknown) => err);

		expect(refused).toBeInstanceOf(AtCapacityError);
		expect(claude.created).toHaveLength(maxSessions);
		expect(sessions.holds({ backend: "claude", id: `${parent.id}#fork-e1` })).toBe(false);
	});

	it("disposes, once, the adapter a Codex fork handed over when the cap refuses its start", async () => {
		// Refused before the startup claims it, so the fork's handover disposes
		// it, and the share it holds of the parent's child goes with it.
		const codexRefs: SessionRef[] = STORED.map((ref) => ({ backend: "codex", id: ref.id }));
		const parent = codexRefs[0] as SessionRef;
		const child = new FakeSharedChild();
		const codex = new FakeAdapterFactory({ forkMode: "shared", sharedChild: child, forkPoints: [{ id: "e1", text: "hi", index: 0 }] });
		index = new FakeSessionIndex(codexRefs.map((ref) => storedSession(ref, WORKSPACE)));
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		for (const ref of codexRefs.slice(0, maxSessions)) {
			await sessions.attach(ref);
			(codex.forRef(ref) as FakeAdapter).setStreaming(true);
		}
		const parentAdapter = codex.forRef(parent) as FakeAdapter;
		const fork = parentAdapter.fork.bind(parentAdapter);
		let built: FakeAdapter | undefined;
		parentAdapter.fork = async (entryId) => {
			const forked = await fork(entryId);
			built = forked.adapter as FakeAdapter;
			return forked;
		};

		const refused = await sessions.forkAndPrompt(parent, 0, "again").catch((err: unknown) => err);

		expect(refused).toBeInstanceOf(AtCapacityError);
		expect(built?.disposals).toBe(1);
		expect(built?.started).toBe(false);
		expect(child.holders).toBe(maxSessions);
	});
});
