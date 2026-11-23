/**
 * Bounded, LF-only line reading for session JSONL files, rather than
 * `node:readline`:
 *
 * 1. LF-only framing. These files hold agent and tool text inside JSON
 *    strings, which may contain U+2028/U+2029, and `readline` splits on those
 *    too, the hazard `docs/BACKENDS.md`'s "Pi RPC framing is LF-only" records
 *    for Pi's stdio.
 * 2. Bounded reads. D9 wants enumeration cheap without a cache to make up for
 *    slow reads, so this never reads more of a file than its caller needs: a
 *    caller that breaks out of its `for await` destroys the stream rather
 *    than draining it, and `maxBytes`/`maxLines` bound the pathological case
 *    (a huge single line, or a file that never yields what the caller wants).
 */

import { createReadStream } from "node:fs";

export interface LineReadOptions {
	/** Soft cap -- once this many bytes have been read from disk, stop. */
	maxBytes?: number;
	/** Hard cap on the number of lines yielded. */
	maxLines?: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_LINES = 200;

export async function* readLinesLfOnly(
	filePath: string,
	opts: LineReadOptions = {},
): AsyncGenerator<string, void, void> {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

	const stream = createReadStream(filePath, { encoding: "utf8" });
	let buffered = "";
	let bytesRead = 0;
	let linesYielded = 0;

	try {
		for await (const chunk of stream) {
			const text = chunk as unknown as string;
			bytesRead += Buffer.byteLength(text, "utf8");
			buffered += text;

			let newlineIndex = buffered.indexOf("\n");
			while (newlineIndex !== -1) {
				yield buffered.slice(0, newlineIndex);
				buffered = buffered.slice(newlineIndex + 1);
				linesYielded++;
				if (linesYielded >= maxLines) return;
				newlineIndex = buffered.indexOf("\n");
			}

			if (bytesRead >= maxBytes) {
				if (buffered.length > 0) yield buffered;
				return;
			}
		}
		if (buffered.length > 0) yield buffered;
	} finally {
		stream.destroy();
	}
}
