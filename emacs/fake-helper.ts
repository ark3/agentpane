/**
 * A stand-in for `src/emacs/main.ts` that the ert tests in
 * `agentpane-test.el` start in its place (OW-bonode), so the helper
 * connection can be driven with no agentpane server behind it.
 *
 *     bun run emacs/fake-helper.ts ORDER
 *
 * Same wire as the real helper, Content-Length-framed JSON-RPC on stdio.
 * `sessions/list` answers one session whose preview counts the listings
 * served so far, `list 1`, `list 2`, ..., so a test can tell which one a
 * picker drew.  `sessions/preview` provokes a nested request: it pushes
 * `sessions/changed` at once, holds its own reply until the refetch that
 * notification causes arrives as a second `sessions/list`, then answers
 * both in ORDER -- `outer-first` (the preview, then the listing 200ms
 * later) or `inner-first`.  ORDER `lists-reversed` instead holds each odd
 * `sessions/list` until the next one arrives and answers that one first,
 * as the real helper may when two of its HTTP calls finish out of order.
 * Exits when stdin ends, as the real helper does.
 */

import { FrameDecoder, encodeFrame } from "../src/emacs/framing.ts";

interface Request {
	id?: number;
	method?: string;
}

const order = process.argv[2] ?? "outer-first";
const send = (message: object): void => void process.stdout.write(encodeFrame({ jsonrpc: "2.0", ...message }));
const log = (text: string): void => void process.stderr.write(`fake-helper: ${text}\n`);

let listings = 0;
let heldPreview: Request | null = null;
let heldListing: object | null = null;

const listing = () => [
	{
		ref: { backend: "pi", id: `session-${listings}` },
		cwd: "/tmp",
		status: "stored",
		isStreaming: false,
		updatedAt: null,
		preview: `list ${listings}`,
	},
];
const transcript = [{ index: 0, role: "user", parts: [{ type: "text", text: "hello", html: "<p>hello</p>" }] }];

const onRequest = (request: Request): void => {
	log(`<- ${request.method} id=${request.id}`);
	switch (request.method) {
		case "sessions/list": {
			listings += 1;
			const reply = { id: request.id, result: listing() };
			if (order === "lists-reversed") {
				const first = heldListing;
				if (first === null) {
					heldListing = reply;
					return;
				}
				heldListing = null;
				send(reply);
				send(first);
				return;
			}
			const held = heldPreview;
			if (held === null) return send(reply);
			heldPreview = null;
			const preview = { id: held.id, result: transcript };
			if (order === "inner-first") {
				send(reply);
				send(preview);
			} else {
				send(preview);
				setTimeout(() => send(reply), 200);
			}
			return;
		}
		case "sessions/preview":
			heldPreview = request;
			send({ method: "sessions/changed" });
			return;
		default:
			send({ id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
	}
};

const decoder = new FrameDecoder();
const reader = Bun.stdin.stream().getReader();
for (;;) {
	const { done, value: chunk } = await reader.read();
	if (done) break;
	for (const message of decoder.push(chunk)) onRequest(message as Request);
}
log("stdin ended");
