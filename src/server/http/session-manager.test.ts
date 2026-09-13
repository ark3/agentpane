/**
 * Process-table edges that are awkward to provoke through HTTP: concurrent
 * attaches, a spawn that fails, and the bookkeeping that must not outlive a
 * session.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type ServerEvent, type SessionRef, sessionKey } from "../../shared/protocol.ts";
import { ClaudeAdapterFactory } from "../adapters/claude/adapter.ts";
import { FakeClaudeProcess } from "../adapters/claude/test-support.ts";
import { Broadcaster } from "./broadcaster.ts";
import { SessionManager, UnknownBackendError, UnknownSessionError } from "./session-manager.ts";
import type { SessionIndex } from "./deps.ts";
import {
	deferred,
	FakeAdapterFactory,
	FakeSessionIndex,
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
		flaky.created[0]?.append(userMessage("ghost"));
		expect(broadcaster.seqOf(REF)).toBe(0);

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
	// path (D9) and a `virtual` session has no path until its first prompt writes
	// one. The adapter documents that its caller must re-read `adapter.ref` after
	// start() and after the first submit(); these are that contract.
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

	it("adopts the id a virtual session materialises on its first prompt (D9)", async () => {
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

	it("moves a pending request's owner across the rename", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnSubmit: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi");
		await sessions.attach(virtualRef);
		const request = renaming.forRef(virtualRef)?.emitRequest("approval");

		await sessions.submit(virtualRef, "first");

		// The agent is still blocked on it, so the reply must still find a session.
		expect(sessions.sessionOfRequest(request?.requestId ?? "")).toEqual({
			backend: "pi",
			id: REAL,
		});
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
});

describe("fork (the third #adoptRef point)", () => {
	// Fork is the third point at which a session's id can change under us, and
	// the backends are asymmetric (settled live, MANUAL_TESTING.md OW-pifowo
	// / OW-22; Claude Code's fork leaves its own ref alone like Codex's,
	// OW-razoki).
	// SessionManager.fork must absorb every shape through #adoptRef.
	it("re-keys and emits `renamed` when a Pi-style fork moves the active file", async () => {
		await sessions.attach(REF);
		const events: { from: SessionRef; to: SessionRef }[] = [];
		const prevRenamed = broadcaster.renamed.bind(broadcaster);
		broadcaster.renamed = (from, to) => {
			events.push({ from, to });
			prevRenamed(from, to);
		};

		const forked = await sessions.fork(REF, "e1");

		// FakeAdapter's Pi fork adopts `${id}#fork-e1`; the manager returns that
		// moved ref and re-keys the table to it.
		const moved: SessionRef = { backend: "pi", id: `${REF.id}#fork-e1` };
		expect(forked).toEqual(moved);
		expect(sessions.liveRefs()).toEqual([moved]);
		expect(events).toEqual([{ from: REF, to: moved }]);
	});

	it("does NOT re-key when a Codex-style fork leaves the adapter's own ref unchanged", async () => {
		const codexRef: SessionRef = { backend: "codex", id: "thread-parent" };
		const codex = new FakeAdapterFactory({ forkMode: "codex" });
		index = new FakeSessionIndex([storedSession(codexRef, WORKSPACE)]);
		sessions = new SessionManager({ index, adapters: { codex } }, broadcaster);
		await sessions.attach(codexRef);
		const renamed: { from: SessionRef; to: SessionRef }[] = [];
		const prevRenamed = broadcaster.renamed.bind(broadcaster);
		broadcaster.renamed = (from, to) => {
			renamed.push({ from, to });
			prevRenamed(from, to);
		};

		const forked = await sessions.fork(codexRef, "e1");

		// The returned ref is the new thread, distinct from the adapter's own ref.
		expect(forked).toEqual({ backend: "codex", id: "thread-parent#fork-e1" });
		// The parent session is still keyed by its original id -- no re-key, no rename.
		expect(sessions.canonicalRef(codexRef)).toEqual(codexRef);
		expect(sessions.liveRefs()).toEqual([codexRef]);
		expect(renamed).toEqual([]);
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

		const forkAdapter = await sessions.attach(forked);

		expect(forkAdapter).not.toBe(parent);
		expect(claude.forRef(forked)?.startOptions).toEqual({
			cwd: WORKSPACE,
			forkOf: { parentId: "parent", entryId: "e1" },
		});
		expect(sessions.liveRefs().map(sessionKey).sort()).toEqual(
			[sessionKey(claudeRef), sessionKey(forked)].sort(),
		);
	});

	// What a ref-changing fork leaves behind for the PARENT (OW-kekoji). The
	// container genuinely moves -- the one live adapter is driving the fork now
	// -- but the parent is a second conversation, not an older name for this
	// one, so no alias is written and the parent's ref stops resolving at all.
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

	it("keeps the parent in list() after a ref-changing fork", async () => {
		await sessions.attach(REF);

		const forked = await sessions.fork(REF, "e1");

		// The index still reports the parent -- its store file is untouched --
		// and nothing aliases its key away, so a client can still see it and
		// re-attach to it alongside the fork.
		const listed = await sessions.list().then((l) => l.map((s) => sessionKey(s.ref)));
		expect(listed).toContain(sessionKey(forked));
		expect(listed).toContain(sessionKey(REF));
	});

	it("keeps the parent in list() when a Codex-style fork leaves the ref unchanged", async () => {
		// The contrast: no re-key means no alias, so the parent stays listed.
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

	it("leaves an older alias of the parent pointing at the parent", async () => {
		// A `virtual:` id that materialised into the parent is an older name for
		// the PARENT's conversation. Following the container onto the fork would
		// recreate the bug one level up: a stale client handle that can kill the
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

		// The alias still names the parent, which is now detached, so it misses
		// -- and a miss is what `canonicalRef` reports by handing `ref` back. Had
		// it followed the container it would resolve to the fork instead.
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

	it("forgets a session's pending requests when it closes", async () => {
		const adapter = await sessions.attach(REF);
		const request = pi.forRef(REF)?.emitRequest("approval");
		expect(sessions.sessionOfRequest(request?.requestId ?? "")).toEqual(REF);

		await sessions.close(REF);

		expect(sessions.sessionOfRequest(request?.requestId ?? "")).toBeUndefined();
		expect((adapter as { disposed?: boolean }).disposed).toBe(true);
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

describe("teardown racing a startup", () => {
	// `start()` is the window in which an adapter already owns a sandboxed child
	// but the manager has not recorded it: `#sessions` only learns about the
	// adapter once `start()` resolves. A teardown that walks the table during
	// that window sees nothing to kill, and the child that surfaces a moment
	// later has nothing left that will ever reap it. Both real adapters take a
	// round trip inside `start()` -- Codex's `initialize`, Pi's `get_state` --
	// so this window is milliseconds wide on every single attach.

	/** Let queued microtasks drain, so `start()` has actually been entered. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 4; i++) await Promise.resolve();
	}

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
		// `#adoptRef` re-keys the session into the table. Run against a session
		// that has already been closed, it puts it back -- a closed conversation
		// reappearing in the list under an id the client never asked for.
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
});
