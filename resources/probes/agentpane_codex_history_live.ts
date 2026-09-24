/**
 * Does agentpane's own Codex adapter reattach and fork a thread without a
 * full-history deprecation? (OW-kelene)
 *
 * Drives the real `CodexAdapterFactory` -- production spawner, so each
 * adapter's app-server runs as `direnv exec <workspace> sbox -- codex
 * app-server` -- from the checkout named by `--root`, which is how the same
 * run can be pointed at the code before a change and after it.
 *
 * Without `--thread`, it first starts a thread and drives two tiny turns on
 * `gpt-5.6-luna`. Then it reattaches the thread in a fresh adapter (a fresh
 * app-server), lists its fork points, forks at the second, and starts the
 * fork's borrowing adapter, printing the transcript roles each one painted,
 * the fork points, and every notice any adapter heard.
 *
 * Usage:  CODEX_HOME=<writable temp home> bun agentpane_codex_history_live.ts \
 *           --root <checkout> --workspace <git dir> [--thread <id>]
 * Needs:  a CODEX_HOME holding copies of `~/.codex/{auth.json,config.toml}`;
 *         never the real `~/.codex`, which sbox mounts read-only.
 */

import { parseArgs } from "node:util";

// Home-server agent sessions pin Codex to one model (AGENTS.md, "Evidence").
const MODEL = "gpt-5.6-luna";

const { values } = parseArgs({
	options: { root: { type: "string" }, workspace: { type: "string" }, thread: { type: "string" } },
});
if (!values.root || !values.workspace || !process.env.CODEX_HOME) {
	throw new Error("need --root, --workspace and CODEX_HOME");
}
const workspace = values.workspace;
const { CodexAdapterFactory } = await import(`${values.root}/src/server/adapters/codex/index.ts`);
const factory = new CodexAdapterFactory();
const notices: { who: string; kind: string; message: string }[] = [];

// Untyped: the adapter comes from whichever checkout `--root` names.
type Adapter = any;

function listen(who: string, adapter: Adapter): Adapter {
	adapter.onNotice((notice: { kind: string; message: string }) => notices.push({ who, kind: notice.kind, message: notice.message }));
	adapter.onError((message: string) => console.log(`[${who}] error: ${message}`));
	return adapter;
}

function turnEnded(adapter: Adapter): Promise<void> {
	return new Promise((resolve, reject) => {
		let started = false;
		const timer = setTimeout(() => reject(new Error("turn did not end in 120s")), 120_000);
		const stop = adapter.onUpdate((state: { isStreaming: boolean }) => {
			if (state.isStreaming) started = true;
			else if (started) {
				clearTimeout(timer);
				stop();
				resolve();
			}
		});
	});
}

function roles(adapter: Adapter): string[] {
	return adapter.getState().messages.map((message: { role: string }) => message.role);
}

let threadId = values.thread;
if (!threadId) {
	const maker = listen("maker", factory.create({ backend: "codex", id: `virtual:${crypto.randomUUID()}` }));
	await maker.start({ cwd: workspace, model: MODEL });
	for (const text of ["Reply with exactly: one", "Reply with exactly: two"]) {
		const ended = turnEnded(maker);
		await maker.submit(text);
		await ended;
		// Idle status can land before `turn/completed` clears the adapter's
		// turn, and a submit in between would be a steer.
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	threadId = maker.ref.id as string;
	console.log("made thread", threadId, "roles", roles(maker));
	await maker.dispose();
}

const reattached = listen("reattach", factory.create({ backend: "codex", id: threadId }));
await reattached.start({ cwd: workspace, resumeId: threadId });
console.log("reattach roles", roles(reattached));
const points = await reattached.listForkPoints();
console.log("fork points", JSON.stringify(points.map((p: { id: string; index: number }) => ({ id: p.id, index: p.index }))));
const second = points[1];
if (!second) throw new Error("no second fork point to fork at");
const forked = await reattached.fork(second.id);
const borrower = listen("fork", forked.adapter);
await borrower.start(forked.start);
console.log("fork", forked.ref.id, "roles", roles(borrower));
// Let anything app-server sends after the last answer arrive before counting.
await new Promise((resolve) => setTimeout(resolve, 2000));
console.log("notices", JSON.stringify(notices));
await borrower.dispose();
await reattached.dispose();
