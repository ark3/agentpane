/**
 * `Content-Length` framing for JSON-RPC over stdio (OW-refibu), the wire
 * `jsonrpc-process-connection` in Emacs's bundled `jsonrpc.el` speaks: a
 * header block of `Name: value` lines ending in a blank line, then exactly
 * `Content-Length` bytes of JSON. Nothing in the repo or its dependencies
 * frames this, so it is written here; the whole of it is these two pieces.
 *
 * The decoder works on bytes, not on a decoded string: `Content-Length`
 * counts bytes, and a chunk boundary can fall inside a multi-byte character.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_END = encoder.encode("\r\n\r\n");

export function encodeFrame(message: unknown): Uint8Array {
	const body = encoder.encode(JSON.stringify(message));
	const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
	const frame = new Uint8Array(header.byteLength + body.byteLength);
	frame.set(header, 0);
	frame.set(body, header.byteLength);
	return frame;
}

/** Accumulates chunks and yields each complete message's parsed JSON, in order. */
export class FrameDecoder {
	#buffer = new Uint8Array(0);

	push(chunk: Uint8Array): unknown[] {
		const joined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
		joined.set(this.#buffer, 0);
		joined.set(chunk, this.#buffer.byteLength);
		this.#buffer = joined;

		const messages: unknown[] = [];
		for (;;) {
			const headerEnd = indexOf(this.#buffer, HEADER_END);
			if (headerEnd < 0) break;
			const length = contentLength(decoder.decode(this.#buffer.subarray(0, headerEnd)));
			const bodyStart = headerEnd + HEADER_END.byteLength;
			if (this.#buffer.byteLength < bodyStart + length) break;
			messages.push(JSON.parse(decoder.decode(this.#buffer.subarray(bodyStart, bodyStart + length))));
			this.#buffer = this.#buffer.slice(bodyStart + length);
		}
		return messages;
	}
}

function contentLength(headers: string): number {
	for (const line of headers.split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
		const length = Number(line.slice(colon + 1).trim());
		if (Number.isInteger(length) && length >= 0) return length;
	}
	throw new Error(`JSON-RPC header block without a Content-Length: ${JSON.stringify(headers)}`);
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let i = 0; i + needle.byteLength <= haystack.byteLength; i++) {
		for (let j = 0; j < needle.byteLength; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}
