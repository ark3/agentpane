/**
 * A server-sent-events reader over `fetch`, for the Emacs helper (OW-refibu).
 *
 * `EventSource` is not a global under the installed `bun 1.4.0`
 * (`bun -e 'console.log(typeof EventSource)'` prints `undefined`, measured
 * 2026-09-22 on the home server), so `defaultOpenEvents` in `$client/api.ts`
 * would throw at runtime while `svelte-check` passes it on the DOM lib types.
 * This is the `openEvents` the helper injects instead: the response body
 * read as a stream and split on the wire's own rules -- lines, a `data:`
 * field per line, a blank line ending the event, a leading `:` a comment,
 * which is what the server's heartbeat is (`broadcaster.ts`).
 *
 * Nothing here retries. Every drop is final for this connection, so
 * `onDisconnect` always reports `fatal: true` and the helper reopens the
 * stream itself (`helper.ts`). `close()` aborts the request and is silent:
 * a native `EventSource.close()` fires no `onerror` either.
 */

import type { EventConnection, EventHandlers } from "$client/api.ts";
import type { ServerEvent } from "$shared/protocol.ts";

export function sseOpenEvents(fetchImpl: typeof fetch): (url: string, handlers: EventHandlers) => EventConnection {
	return (url, handlers) => {
		const controller = new AbortController();
		const { signal } = controller;

		const run = async (): Promise<void> => {
			const response = await fetchImpl(url, { headers: { accept: "text/event-stream" }, signal });
			if (response.status !== 200 || response.body === null) throw new Error(`event stream answered ${response.status}`);
			handlers.onOpen();
			const decoder = new TextDecoder();
			let pending = "";
			let data: string[] = [];
			const reader = response.body.getReader();
			for (;;) {
				const { done, value: chunk } = await reader.read();
				if (done || signal.aborted) return;
				pending += decoder.decode(chunk, { stream: true });
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const raw of lines) {
					const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
					if (line === "") {
						if (data.length > 0) dispatch(data.join("\n"));
						data = [];
					} else if (line.startsWith("data:")) {
						data.push(line.slice(5).replace(/^ /, ""));
					}
					// Comments and the `event:`/`id:`/`retry:` fields the server never sends fall through.
				}
			}
		};

		const dispatch = (text: string): void => {
			if (signal.aborted) return;
			let parsed: ServerEvent;
			try {
				parsed = JSON.parse(text) as ServerEvent;
			} catch (error: unknown) {
				handlers.onMalformed(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			handlers.onEvent(parsed);
		};

		run().then(
			() => {
				if (!signal.aborted) handlers.onDisconnect(true);
			},
			() => {
				if (!signal.aborted) handlers.onDisconnect(true);
			},
		);

		return {
			close() {
				controller.abort();
			},
		};
	};
}
