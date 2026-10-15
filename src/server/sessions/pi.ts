/**
 * Pi session file -> SessionSummary.
 *
 * Header: HANDOFF finding 18 -- `{"type":"session",...,cwd}`. Census on this
 * machine found all 390 files consistent with this shape (no drift observed
 * yet, unlike Codex), but header parsing still degrades to unknown-workspace
 * rather than throwing if that ever changes.
 *
 * Unlike Codex, a random sample of 15 Pi sessions found the first "user"-role
 * message was always the real, human-typed first message (2-4 header/system
 * lines in, then the message) -- no synthetic wrapper turns observed. So no
 * filtering heuristic here; see codex.ts for why Codex needs one.
 */

import type { Stats } from "node:fs";
import type { SessionPreviewTurn, SessionSummary } from "../../shared/protocol.ts";
import { activeBranch } from "../adapters/pi/reducer.ts";
import { readLinesLfOnly } from "./line-reader.ts";
import { storedAgentMessage } from "./preview-message.ts";
import { trimPreview } from "./text.ts";

interface ParsedHeader {
	cwd: string | null;
	createdAt: string | null;
}

const EMPTY_HEADER: ParsedHeader = { cwd: null, createdAt: null };

function parseHeader(line: string): ParsedHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return EMPTY_HEADER;
	}
	if (typeof parsed !== "object" || parsed === null) return EMPTY_HEADER;
	const rec = parsed as Record<string, unknown>;
	if (rec.type !== "session") return EMPTY_HEADER;
	return {
		cwd: typeof rec.cwd === "string" ? rec.cwd : null,
		createdAt: typeof rec.timestamp === "string" ? rec.timestamp : null,
	};
}

function extractUserMessageTexts(line: string): string[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Record<string, unknown>;
	if (rec.type !== "message") return null;

	const message = rec.message;
	if (typeof message !== "object" || message === null) return null;
	const msg = message as Record<string, unknown>;
	if (msg.role !== "user" || !Array.isArray(msg.content)) return null;

	const texts: string[] = [];
	for (const block of msg.content) {
		if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
		}
	}
	return texts;
}

export async function parsePiSession(filePath: string, stat: Stats): Promise<SessionSummary> {
	let header: ParsedHeader = EMPTY_HEADER;
	let preview: string | null = null;

	try {
		let lineNo = 0;
		for await (const line of readLinesLfOnly(filePath)) {
			lineNo++;
			if (lineNo === 1) {
				header = parseHeader(line);
				continue;
			}
			const texts = extractUserMessageTexts(line);
			if (!texts) continue;
			const joined = texts
				.filter((t) => t.trim().length > 0)
				.join(" ")
				.trim();
			if (joined) {
				preview = trimPreview(joined);
				break;
			}
		}
	} catch {
		// Unreadable file -- tolerate, matching the Codex parser.
	}

	return {
		// DESIGN D9: Pi's session identity IS its JSONL path, not the header's
		// own `id` field.
		ref: { backend: "pi", id: filePath },
		cwd: header.cwd,
		preview,
		createdAt: header.createdAt,
		updatedAt: stat.mtime.toISOString(),
		// Read from the store by a later card (D27, OW-yilene).
		name: null,
		status: "detached",
		isStreaming: false,
		onDisk: true,
	};
}

/**
 * The full transcript of a stored Pi session for the read-only preview
 * (OW-38). Pi stores message payloads in the same structural shape the live
 * adapter renders, so this validates and retains user, assistant,
 * tool-result and system messages with their thinking, tool, and image
 * blocks, and draws each compaction entry as the marker live appends at
 * `compaction_end`, where it sits on the branch (OW-livowu). The header is
 * skipped.
 *
 * A session file is a tree, and a branch made in place leaves the abandoned
 * entries in it, so this draws only the branch Pi would resume at, as the
 * live transcript does (OW-gogoka). As of `pi 1.2.0`, `SessionManager`
 * (`dist/core/session-manager.js`) loads a file and `_buildIndex` takes as
 * its leaf the last entry that is not the `session` header, of whatever type
 * -- every entry, `model_change`, `compaction` and `label` alike, carries an
 * `id` and a `parentId` and so sits on the chain. The branch is the walk from
 * there by `parentId`, stopping at an id the file does not hold, as
 * `buildSessionPath` does. A header with no `version` is version 1, whose
 * entries carry no ids at all: Pi's `migrateV1ToV2` chains them in file
 * order, so that order is the branch.
 */
export async function extractPiPreviewTurns(filePath: string): Promise<SessionPreviewTurn[]> {
	let version = 1;
	const entries: StoredEntry[] = [];
	let lineNo = 0;
	// Unbounded: unlike enumeration, the preview must reach the real end of the
	// file (attaching already shows the whole transcript, so the preview
	// stopping early at the enumeration caps would be a visible regression).
	for await (const line of readLinesLfOnly(filePath, { maxLines: Infinity, maxBytes: Infinity })) {
		lineNo++;
		const rec = parseRecord(line);
		if (lineNo === 1) {
			if (typeof rec?.version === "number") version = rec.version;
			continue;
		}
		if (rec && rec.type !== "session") entries.push(rec as StoredEntry);
	}
	const branch = version < 2 ? entries : activeBranch(entries, entries.at(-1)?.id ?? null);
	return branch.flatMap((entry) => extractPreviewTurn(entry) ?? []);
}

/** One parsed line of a session file, its ids as Pi reads them, unvalidated. */
type StoredEntry = Record<string, unknown> & { id: string; parentId: string | null };

function parseRecord(line: string): Record<string, unknown> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

/**
 * One transcript message from a Pi `message` entry, or the compaction marker
 * from a `compaction` entry, or null for other records. As of `pi 1.2.0` a
 * compaction is stored as its own `type: "compaction"` entry, not as a
 * `compactionSummary` message; of its fields the marker keeps `summary` and
 * `tokensBefore`, all that `compaction_end`'s live one carries.
 *
 * A turn's time is the message's own epoch-ms `timestamp`, the one live reads.
 * As of `pi 1.2.0` Pi stamps it when the message starts, and the entry's ISO
 * `timestamp` when it appends the message, at its end, so by the entry's an
 * assistant turn would read up to its own length late (OW-jiwaso). The entry's
 * time stands in only for a message without its own, and for the compaction
 * marker, which has none.
 */
function extractPreviewTurn(rec: Record<string, unknown>): SessionPreviewTurn | null {
	if (rec.type !== "message" && rec.type !== "compaction") return null;

	const message = rec.type === "compaction"
		? { role: "compactionSummary", summary: rec.summary, tokensBefore: rec.tokensBefore }
		: rec.message;
	const own = typeof message === "object" && message !== null
		? (message as Record<string, unknown>).timestamp
		: undefined;
	const timestamp = typeof own === "number" && Number.isFinite(own)
		? new Date(own).toISOString()
		: typeof rec.timestamp === "string" ? rec.timestamp : undefined;
	return storedAgentMessage(message, timestamp, {
		api: "anthropic-messages",
		provider: "anthropic",
		model: "pi",
	});
}
