/**
 * Bounded, LF-only line reading for session JSONL files.
 *
 * Two things drive this rather than `node:readline`:
 *
 * 1. LF-only framing. HANDOFF's "Pi RPC framing is LF-only" gotcha is about
 *    stdio framing, but the same hazard applies here: these files hold
 *    arbitrary agent/tool text inside JSON string values, which can legally
 *    contain U+2028/U+2029. `readline`'s default line splitting treats those
 *    as line breaks too, which would corrupt a line mid-JSON. We split on
 *    `\n` only.
 * 2. Bounded reads. DESIGN D9 wants enumeration cheap and explicitly does not
 *    want a cache built to compensate for slow reads. The cheapest way to
 *    keep it cheap is to never read more of a file than necessary: this is an
 *    async generator so a caller that finds what it needs after a few lines
 *    (typical case) can `break` out of a `for await` loop, which destroys the
 *    underlying stream via the `finally` block instead of draining it.
 *    `maxBytes`/`maxLines` bound the pathological case (huge single line, or
 *    a file that never yields what the caller wants).
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
