/**
 * Pi RPC framing: strict JSONL with LF (`\n`) as the only record delimiter.
 *
 * Deliberately not `node:readline`. `readline` also splits on U+2028 (LINE
 * SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), which are valid unescaped
 * characters inside a JSON string -- a model response that happens to
 * contain one would get its line torn in half and fail to parse. See
 * rpc.md's "Framing" section and HANDOFF's "Environment gotchas".
 *
 * This is pure and synchronous on purpose: it takes decoded string chunks
 * in and hands complete lines back out, with no I/O of its own, so it can
 * be driven by a test with no subprocess involved.
 */

export class LfLineSplitter {
	private buffer = "";

	/** Feed a chunk of decoded text; returns zero or more complete lines. */
	push(chunk: string): string[] {
		this.buffer += chunk;
		const lines: string[] = [];
		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
			lines.push(stripTrailingCr(this.buffer.slice(0, newlineIndex)));
			this.buffer = this.buffer.slice(newlineIndex + 1);
		}
		return lines;
	}

	/**
	 * Call once the stream has ended. Returns the trailing partial line, if
	 * any content remains unterminated by a final `\n`.
	 */
	flush(): string[] {
		if (this.buffer.length === 0) return [];
		const line = stripTrailingCr(this.buffer);
		this.buffer = "";
		return [line];
	}
}

function stripTrailingCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}
