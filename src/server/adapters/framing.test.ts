import { describe, expect, it } from "vitest";
import { LfLineSplitter } from "./framing.ts";

describe("LfLineSplitter", () => {
	it("splits multiple LF-terminated lines from a single chunk", () => {
		const splitter = new LfLineSplitter();
		const lines = splitter.push('{"a":1}\n{"b":2}\n');
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("buffers a line split across chunks", () => {
		const splitter = new LfLineSplitter();
		expect(splitter.push('{"a":')).toEqual([]);
		expect(splitter.push("1}\n")).toEqual(['{"a":1}']);
	});

	it("strips a trailing CR (tolerates CRLF input)", () => {
		const splitter = new LfLineSplitter();
		const lines = splitter.push('{"a":1}\r\n{"b":2}\r\n');
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("does not split on U+2028 or U+2029, unlike node:readline", () => {
		// rpc.md's framing note, verbatim: these are valid inside a JSON string
		// and must not be treated as record separators. A payload carrying one
		// must survive as a single line and remain valid JSON.
		const lineSeparator = String.fromCharCode(0x2028);
		const paragraphSeparator = String.fromCharCode(0x2029);
		const delta = `before${lineSeparator}middle${paragraphSeparator}after`;
		const payload = JSON.stringify({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
		});

		const splitter = new LfLineSplitter();
		const lines = splitter.push(`${payload}\n`);

		expect(lines).toEqual([payload]);
		expect(JSON.parse(lines[0] as string).assistantMessageEvent.delta).toBe(delta);
	});

	it("flush() returns a trailing line with no terminating newline", () => {
		const splitter = new LfLineSplitter();
		expect(splitter.push('{"a":1}\n{"b":2}')).toEqual(['{"a":1}']);
		expect(splitter.flush()).toEqual(['{"b":2}']);
	});

	it("flush() returns nothing when the buffer is empty (clean EOF)", () => {
		const splitter = new LfLineSplitter();
		splitter.push('{"a":1}\n');
		expect(splitter.flush()).toEqual([]);
	});

	it("handles an empty line between two records", () => {
		const splitter = new LfLineSplitter();
		const lines = splitter.push('{"a":1}\n\n{"b":2}\n');
		expect(lines).toEqual(['{"a":1}', "", '{"b":2}']);
	});
});

describe("LfLineSplitter, the cases Codex's own splitter was pinned by", () => {
	it("uses LF as the only record delimiter, preserving U+2028 and U+2029 inside JSON", () => {
		const splitter = new LfLineSplitter();
		const lines: string[] = [];
		const lineSeparator = String.fromCharCode(0x2028);
		const paragraphSeparator = String.fromCharCode(0x2029);
		const text = `before${lineSeparator}middle${paragraphSeparator}after`;
		const payload = JSON.stringify({ method: "item/agentMessage/delta", params: { delta: text } });

		lines.push(...splitter.push(`${payload}\n`));

		expect(lines).toEqual([payload]);
		expect(JSON.parse(lines[0] as string).params.delta).toBe(text);
	});

	it("buffers partial chunks and emits each completed LF-delimited line", () => {
		const splitter = new LfLineSplitter();
		const lines: string[] = [];

		lines.push(...splitter.push('{"id":1,"res'));
		expect(lines).toEqual([]);
		lines.push(...splitter.push('ult":true}\n{"id":2,"result":false}\n'));

		expect(lines).toEqual(['{"id":1,"result":true}', '{"id":2,"result":false}']);
	});

	it("flushes a final unterminated line exactly once", () => {
		const splitter = new LfLineSplitter();
		const lines: string[] = [];
		lines.push(...splitter.push('{"id":1,"result":true}\n{"id":2,"result":false}'));

		lines.push(...splitter.flush());
		lines.push(...splitter.flush());

		expect(lines).toEqual(['{"id":1,"result":true}', '{"id":2,"result":false}']);
	});

	it("preserves a whitespace-only LF frame for protocol validation", () => {
		const splitter = new LfLineSplitter();
		const lines: string[] = [];

		lines.push(...splitter.push(" \t\n"));

		expect(lines).toEqual([" \t"]);
	});
});
