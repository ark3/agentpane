/**
 * A stand-in for `src/emacs/main.ts` whose server closes its socket with a
 * prompt in flight (OW-hiliti, D31 point 6): the real `runHelper`, on stdin
 * and stdout, over a socket that opens at once, answers the `hello` and every
 * `sessions/list` with an empty listing, holds every other command
 * unanswered -- a prompt the server has and has not answered -- and closes
 * 500 ms after it opens. Driven by `emacs_helper_drop_probe.el`.
 *
 * Usage:  bun run emacs_helper_drop_stand_in.ts
 */

import type { SocketLike } from "../../src/client/api.ts";
import type { HelperOptions } from "../../src/emacs/helper.ts";
import { runHelper } from "../../src/emacs/helper.ts";

function standInSocket(): SocketLike {
	const socket: SocketLike = {
		onopen: null,
		onmessage: null,
		onclose: null,
		onerror: null,
		send(data) {
			const frame = JSON.parse(data) as { id: string; cmd: string };
			const result = frame.cmd === "hello" ? null : frame.cmd === "sessions/list" ? { sessions: [] } : undefined;
			if (result === undefined) return;
			setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: "reply", id: frame.id, ok: true, result }) }), 0);
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
