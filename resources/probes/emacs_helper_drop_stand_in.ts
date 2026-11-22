/**
 * A stand-in for `src/emacs/main.ts` whose server closes its socket with a
 * prompt in flight (OW-hiliti, D31 point 6): the real `runHelper`, on stdin
 * and stdout, over a socket that opens at once, answers the `hello` and every
 * `sessions/list` with an empty listing, and every `sessions/attach` as the
 * server does, with the session's snapshot under the handle `h1` and then
 * its summary, so the helper binds the probe's view (D32 point 1); holds
 * every other command unanswered -- a prompt the server has and has not
 * answered -- and closes 500 ms after it opens. At a `sessions/prompt` it
 * first sends the session's `status` with `isStreaming: true` under `h1`, so
 * the helper's turn-done watch sees the turn streaming (D32 point 6). Driven
 * by `emacs_helper_drop_probe.el`.
 *
 * Usage:  bun run emacs_helper_drop_stand_in.ts
 */

import type { SocketLike } from "../../src/client/api.ts";
import type { HelperOptions } from "../../src/emacs/helper.ts";
import { runHelper } from "../../src/emacs/helper.ts";
import type { SessionRef } from "../../src/shared/protocol.ts";

function standInSocket(): SocketLike {
	/** The ref the last attach named, which the streaming status carries. */
	let attached: SessionRef | null = null;
	const deliver = (frame: object) => setTimeout(() => socket.onmessage?.({ data: JSON.stringify(frame) }), 0);
	const socket: SocketLike = {
		onopen: null,
		onmessage: null,
		onclose: null,
		onerror: null,
		send(data) {
			const frame = JSON.parse(data) as { id: string; cmd: string; ref?: SessionRef };
			if (frame.cmd === "sessions/attach") {
				const ref = frame.ref!;
				attached = ref;
				const event = { type: "snapshot", session: ref, handle: "h1", seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] };
				const summary = { ref, cwd: "/tmp", preview: null, createdAt: null, updatedAt: null, status: "attached", isStreaming: false, onDisk: true, name: null, handle: "h1" };
				deliver({ type: "event", event });
				deliver({ type: "reply", id: frame.id, ok: true, result: { session: summary } });
				return;
			}
			if (frame.cmd === "sessions/prompt") {
				deliver({ type: "event", event: { type: "status", session: attached, handle: "h1", seq: 2, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null } });
				return;
			}
			const result = frame.cmd === "hello" ? null : frame.cmd === "sessions/list" ? { sessions: [] } : undefined;
			if (result === undefined) return;
			deliver({ type: "reply", id: frame.id, ok: true, result });
		},
		close() {},
	};
	setTimeout(() => {
		socket.onopen?.();
		setTimeout(() => socket.onclose?.({ code: 1006, reason: "" }), 500);
	}, 0);
	return socket;
}

await runHelper({
	input: Bun.stdin.stream(),
	write: (frame) => void process.stdout.write(frame),
	openSocket: standInSocket,
	token: () => ({ value: "stand-in", refusal: "" }),
	render: ((markdown: string) => markdown) as unknown as HelperOptions["render"],
});
