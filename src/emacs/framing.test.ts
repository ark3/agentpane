/**
 * `Content-Length` framing for the JSON-RPC stdio link (OW-refibu): the
 * decoder has to survive whatever chunking the pipe imposes.
 */

import { describe, expect, it } from "vitest";
import { FrameDecoder, encodeFrame } from "./framing.ts";

const encoder = new TextEncoder();

describe("Content-Length framing", () => {
	it("encodes a message as a header block, a blank line, and the JSON body in UTF-8 bytes", () => {
		const bytes = encodeFrame({ jsonrpc: "2.0", method: "ping", params: { text: "héllo" } });
		const text = new TextDecoder().decode(bytes);
		const body = JSON.stringify({ jsonrpc: "2.0", method: "ping", params: { text: "héllo" } });
		expect(text).toBe(`Content-Length: ${encoder.encode(body).byteLength}\r\n\r\n${body}`);
	});

	it("reads two messages arriving in one chunk", () => {
		const decoder = new FrameDecoder();
		const chunk = new Uint8Array([...encodeFrame({ id: 1 }), ...encodeFrame({ id: 2 })]);
		expect(decoder.push(chunk)).toEqual([{ id: 1 }, { id: 2 }]);
	});

	it("reads one message arriving across two chunks, split inside the body", () => {
		const decoder = new FrameDecoder();
		const frame = encodeFrame({ id: 3, text: "héllo wörld" });
		// Split inside a multi-byte character so a naive string decode would corrupt it.
		const cut = frame.indexOf(0xc3) + 1;
		expect(decoder.push(frame.slice(0, cut))).toEqual([]);
		expect(decoder.push(frame.slice(cut))).toEqual([{ id: 3, text: "héllo wörld" }]);
	});

	it("reads a message whose header block is split across chunks", () => {
		const decoder = new FrameDecoder();
		const frame = encodeFrame({ id: 4 });
		expect(decoder.push(frame.slice(0, 5))).toEqual([]);
		expect(decoder.push(frame.slice(5))).toEqual([{ id: 4 }]);
	});

	it("accepts a lower-case header name and a second header, as jsonrpc.el may send", () => {
		const decoder = new FrameDecoder();
		const body = JSON.stringify({ id: 5 });
		const raw = encoder.encode(`content-length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`);
		expect(decoder.push(raw)).toEqual([{ id: 5 }]);
	});

	it("throws on a header block without a Content-Length", () => {
		const decoder = new FrameDecoder();
		expect(() => decoder.push(encoder.encode("Content-Type: text/plain\r\n\r\n{}"))).toThrow(/Content-Length/);
	});
});
