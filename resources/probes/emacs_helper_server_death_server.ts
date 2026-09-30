/**
 * A stand-in agentpane server for `emacs_helper_server_death_probe.el`
 * (OW-hiliti): it serves an event stream that stays open, an empty session
 * listing, and holds every other request open unanswered -- a prompt it has
 * admitted and not yet answered -- until the probe kills it. It listens on a
 * free loopback port and prints `ready <port>` once it does.
 *
 * Usage:  bun run emacs_helper_server_death_server.ts
 */

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	fetch(request) {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/api/events") {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(": open\n\n"));
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		}
		if (request.method === "GET" && url.pathname === "/api/sessions") return Response.json({ sessions: [] });
		return new Promise<Response>(() => {});
	},
});
console.log(`ready ${server.port}`);
