/**
 * What does a WebSocket do under Bun, as a server and as a client, and in
 * Chromium as a client, in the three places D31 leans on it?
 *
 * 1. Order of handling. The server writes a burst of frames in one
 *    synchronous run; each client logs its `message` handlers beside a
 *    promise continuation each handler starts. Shows whether a continuation
 *    begun by message N runs before message N+1's handler.
 * 2. What closes an idle socket: the `websocket` handler's `idleTimeout`
 *    with and without `sendPings`, and `Bun.serve`'s own `idleTimeout`.
 * 3. Large frames each way under the default `websocket` options, and what
 *    `ws.send` returns for them.
 *
 * It drives no agentpane code and no backend: every server here is a bare
 * `Bun.serve` on a free loopback port.
 *
 * Usage:  bun websocket_runtime_probe.ts [--chromium <binary>] [--skip-chromium]
 *         `--chromium` names the browser binary where Playwright's own
 *         download is not the one installed, as in a claude.ai cloud
 *         container (`docs/ENVIRONMENT.md`, "Cloud containers").
 * Costs:  nothing; about 20s.
 */

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: { chromium: { type: "string" }, "skip-chromium": { type: "boolean", default: false } },
});

const MB = 1024 * 1024;

// -- 1. order of handling ----------------------------------------------------

const BURST = 6;

/** Runs in Bun and, stringified, in the page: no closure over this module. */
function burstClient(port: number, burst: number): Promise<string[]> {
	return new Promise((resolve) => {
		const log: string[] = [];
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		ws.onmessage = (event) => {
			const { n } = JSON.parse(event.data as string) as { n: number };
			log.push(`msg${n}`);
			void Promise.resolve().then(() => log.push(`then${n}`));
			void (async () => {
				await null;
				await null;
				log.push(`await${n}`);
			})();
			if (n === burst - 1) {
				setTimeout(() => {
					ws.close();
					resolve(log);
				}, 50);
			}
		};
	});
}

async function order(): Promise<void> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const { pathname } = new URL(request.url);
			if (pathname === "/ws") return srv.upgrade(request) ? undefined : new Response("no upgrade", { status: 400 });
			return new Response("<!doctype html><title>probe</title>", { headers: { "content-type": "text/html" } });
		},
		websocket: {
			open(ws) {
				// One synchronous run, one frame large enough to span reads.
				for (let n = 0; n < BURST; n++) ws.send(JSON.stringify({ n, pad: "x".repeat(n === 2 ? 200_000 : 10) }));
			},
			message() {},
		},
	});
	const port = server.port as number;
	const inOrder = (log: string[]): boolean =>
		log.join() === Array.from({ length: BURST }, (_, n) => [`msg${n}`, `then${n}`, `await${n}`]).flat().join();

	const bunLog = await burstClient(port, BURST);
	console.log(`order  bun ${Bun.version} client: ${inOrder(bunLog) ? "each message's continuations ran before the next message" : "INTERLEAVED"}`);
	if (!inOrder(bunLog)) console.log(`       ${JSON.stringify(bunLog)}`);

	if (!args["skip-chromium"]) {
		const { chromium } = await import("@playwright/test");
		const browser = await chromium.launch(args.chromium ? { executablePath: args.chromium } : {});
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${port}/page`);
		const log = (await page.evaluate(`(${burstClient.toString()})(${port}, ${BURST})`)) as string[];
		console.log(`order  chromium ${browser.version()} client: ${inOrder(log) ? "each message's continuations ran before the next message" : "INTERLEAVED"}`);
		if (!inOrder(log)) console.log(`       ${JSON.stringify(log)}`);
		await browser.close();
	}
	await server.stop(true);
}

// -- 2. what closes an idle socket -------------------------------------------

async function idle(label: string, serveIdle: number | undefined, websocket: Record<string, unknown>, seconds: number): Promise<void> {
	let pongs = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		...(serveIdle === undefined ? {} : { idleTimeout: serveIdle }),
		fetch(request, srv) {
			return srv.upgrade(request) ? undefined : new Response("no upgrade", { status: 400 });
		},
		websocket: {
			message() {},
			pong() {
				pongs++;
			},
			...websocket,
		},
	});
	const started = performance.now();
	const outcome = await new Promise<string>((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
		ws.onclose = (event) => resolve(`closed ${event.code} after ${((performance.now() - started) / 1000).toFixed(1)}s`);
		setTimeout(() => {
			resolve(`still open after ${seconds}s`);
			ws.close();
		}, seconds * 1000);
	});
	console.log(`idle   ${label}: ${outcome}; the server saw ${pongs} pongs`);
	await server.stop(true);
}

// -- 3. large frames ---------------------------------------------------------

function outbound(size: number): Promise<string> {
	return new Promise((resolve) => {
		let sent: number | undefined;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, srv) {
				return srv.upgrade(request) ? undefined : new Response("no upgrade", { status: 400 });
			},
			websocket: {
				open(ws) {
					sent = ws.send("x".repeat(size));
				},
				message() {},
			},
		});
		let done = false;
		const finish = (how: string): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(`send() returned ${sent}; ${how}`);
			void server.stop(true);
		};
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
		const timer = setTimeout(() => finish("nothing within 8s"), 8000);
		ws.onmessage = (event) => finish(`the client received ${(event.data as string).length / MB} MB`);
		ws.onclose = (event) => finish(`the client saw close ${event.code}`);
	});
}

function inbound(size: number): Promise<string> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (how: string): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(how);
			void server.stop(true);
		};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, srv) {
				return srv.upgrade(request) ? undefined : new Response("no upgrade", { status: 400 });
			},
			websocket: {
				message(_ws, message) {
					finish(`the server received ${(message as string).length / MB} MB`);
				},
				close(_ws, code, reason) {
					finish(`the server closed the socket, ${code} "${reason}"`);
				},
			},
		});
		const timer = setTimeout(() => finish("nothing within 8s"), 8000);
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
		ws.onopen = () => ws.send("x".repeat(size));
	});
}

// ---------------------------------------------------------------------------

console.log(`bun ${Bun.version}`);
await order();
await Promise.all([
	idle("websocket idleTimeout 4s, sendPings default", undefined, { idleTimeout: 4 }, 14),
	idle("websocket idleTimeout 4s, sendPings false", undefined, { idleTimeout: 4, sendPings: false }, 14),
	idle("Bun.serve idleTimeout 3s, websocket options default", 3, {}, 14),
]);
for (const mb of [1, 15, 17, 40, 130]) {
	console.log(`frame  ${mb} MB server to client: ${await outbound(mb * MB)}`);
	console.log(`frame  ${mb} MB client to server: ${await inbound(mb * MB)}`);
}
process.exit(0);
