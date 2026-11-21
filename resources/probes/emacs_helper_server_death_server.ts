/**
 * A stand-in agentpane server for `emacs_helper_server_death_probe.el`
 * (OW-hiliti): it serves the socket (D31), answering the `hello` whatever
 * token it carries, every `sessions/list` with an empty listing, and every
 * `sessions/attach` with the session's snapshot under the handle `h1` and
 * then its summary, so the helper binds the probe's view (D32 point 1); and
 * holds every other command unanswered -- a prompt it has admitted and not
 * yet answered -- until the probe kills it. It listens on a free loopback
 * port and prints `ready <port>` once it does.
 *
 * Usage:  bun run emacs_helper_server_death_server.ts
 */

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request, server) {
		if (new URL(request.url).pathname === "/api/socket" && server.upgrade(request)) return undefined;
		return new Response("not found", { status: 404 });
	},
	websocket: {
		message(socket, data) {
			const frame = JSON.parse(String(data)) as { id: string; cmd: string; ref?: unknown };
			if (frame.cmd === "sessions/attach") {
				const ref = frame.ref;
				const event = { type: "snapshot", session: ref, handle: "h1", seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] };
				const summary = { ref, cwd: "/tmp", preview: null, createdAt: null, updatedAt: null, status: "attached", isStreaming: false, onDisk: true, name: null, handle: "h1" };
				socket.send(JSON.stringify({ type: "event", event }));
				socket.send(JSON.stringify({ type: "reply", id: frame.id, ok: true, result: { session: summary } }));
			} else if (frame.cmd === "hello") socket.send(JSON.stringify({ type: "reply", id: frame.id, ok: true, result: null }));
			else if (frame.cmd === "sessions/list") socket.send(JSON.stringify({ type: "reply", id: frame.id, ok: true, result: { sessions: [] } }));
		},
	},
});
console.log(`ready ${server.port}`);
