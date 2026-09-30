/**
 * A stand-in for `src/emacs/main.ts` whose server drops its event stream
 * with a prompt in flight (OW-hiliti): the real `runHelper`, on stdin and
 * stdout, over a `fetch` that answers every GET with the JSON body `[]` and
 * holds every POST open until its signal fires -- a prompt the server has
 * and has not answered -- and an event stream that opens at once and drops
 * 500 ms later. Driven by `emacs_helper_drop_probe.el`.
 *
 * Usage:  bun run emacs_helper_drop_stand_in.ts
 */

import type { HelperOptions } from "../../src/emacs/helper.ts";
import { runHelper } from "../../src/emacs/helper.ts";

const fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
	if (init?.method === undefined || init.method === "GET") {
		return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
	}
	return new Promise<Response>((_resolve, reject) => {
		init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
	});
}) as typeof globalThis.fetch;

const openEvents: HelperOptions["openEvents"] = (_url, handlers) => {
	setTimeout(() => handlers.onOpen(), 0);
	setTimeout(() => handlers.onDisconnect(false), 500);
	return { close() {} };
};

await runHelper({
	input: Bun.stdin.stream(),
	write: (frame) => void process.stdout.write(frame),
	fetch,
	openEvents,
	render: ((markdown: string) => markdown) as unknown as HelperOptions["render"],
});
