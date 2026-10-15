/**
 * The shape of a Pi session store, and what of it agentpane does not read
 * (OW-tadoju). Structure only, never content.
 *
 * Usage:  bun resources/probes/pi_store_survey.ts [store root]
 *         (root defaults to ~/.pi/agent/sessions; read only, writes nothing)
 * Needs:  bun and this checkout's `src/server/sessions/preview-message.ts`;
 *         no `bun install`, since that module imports types only.
 *
 * It reads every `*.jsonl` under the root whose line 1 is a Pi session header
 * (`type: "session"`), and prints two sections. Files without one, and
 * directories and files it cannot read, are counted (the unreadable ones by
 * error code) and never walked or named; a root it cannot list prints one
 * line naming the error code and exits 1.
 *
 * "Census", grouped by the UTC month of each file's modification time (a Pi
 * file does not name the Pi version that wrote it): for each position --
 * `header(session)` for line 1, `entry(<type>)` for every later line,
 * `message(<role>)` for a message entry's payload, and the schema objects
 * below it -- how many there were, every key they carried with the kinds of
 * value it held, and the values of the few enumerated fields named in
 * `enumeratedValue`. Each month also counts the entries whose `parentId` is
 * not the `id` on the line before (after the first entry), and the files
 * holding them: a Pi file is a tree, and each such entry starts a branch
 * that the preview, reading every message line in file order, draws as one
 * line with the branch it left.
 *
 * "Not read by agentpane", over all months: entry types no reader reads,
 * messages and content blocks `storedAgentMessage` drops whole, and each key
 * sorted into one of three classes.
 *   named    -- the reader reads the key by name, so somebody designed for it.
 *               Never listed: this section lists only the other two.
 *   carried  -- never read by name, but copied onto the preview wire by one of
 *               the reader's object spreads (`...stored`, `...value`), so it
 *               reaches the clients without the reader vouching for its shape.
 *               A client may still read it by name; this probe reads only the
 *               readers, so whether one does is for the person reading this.
 *   dropped  -- neither: no reader reads it and it does not reach the wire.
 * Entry-level reads are the hand-kept `ENTRY_READS`, which mirrors
 * `parsePiSession` and `extractPiPreviewTurns` in `src/server/sessions/pi.ts`.
 * Message- and block-level reads are not kept by hand: each message is handed
 * to the real `storedAgentMessage` through a Proxy that records each property
 * read. Object spread reads a property's descriptor and then its value, which
 * a named read never does, so a read with no descriptor read just before it is
 * a named one; a spread-copied key is carried when it is on the returned turn.
 * Content blocks are tagged with a symbol, which spread copies too, to tell
 * which of them survived. So the classes follow whatever the checkout's reader
 * does today, and the entry-level table is the one thing to update by hand.
 * Objects below a message or a block (`usage`, `usage.cost`, `toolsAdded[]`)
 * are surveyed but not classified: they go wherever their parent key goes.
 *
 * The no-content guarantee, which `src/server/sessions/pi-store-survey.test.ts`
 * holds on a store seeded with one string in every content position it could
 * name, is narrower than "structure only" sounds:
 *  - No value, path or name from the store is printed: not the root, a
 *    directory or file name, a filesystem error's message, or any string,
 *    number or boolean, apart from the enumerated values below.
 *  - Keys and discriminators -- the `type` of an entry and of a content block
 *    and the `role` of a message -- are printed only if they are short
 *    identifiers (anything else prints as `<non-identifier key>` or
 *    `<non-identifier>`) and only at the schema positions the walk reaches.
 *  - The walk descends only along `ENTRY_CHILDREN` and `DESCENT`: an entry, a
 *    message, a content block, `usage` and its `cost`, the items of
 *    `toolsAdded` and `toolsRemoved`, a compaction's `systemMessage`, a context
 *    edit's `replacement`. It never descends into an object whose keys can be
 *    data: a tool call's `arguments`, a tool result's or an extension's
 *    `details`, a custom entry's `data`, a system message's `sections` (keyed
 *    by section name), a tool's `parameters` (keyed by parameter name), nor any
 *    object under an entry type it does not know.
 *  - Enumerated values are printed only for the allowlist in
 *    `enumeratedValue`, and only when the value is a member of pi-ai 1.2.0's
 *    `StopReason` or pi-agent-core 1.2.0's `ThinkingLevel`; anything else
 *    prints as `<unlisted>`. The header's `version` prints only as an integer.
 *  - What that does not enforce, and trusts: that code, not a user, chose the
 *    keys and discriminators at those positions. Pi's own code does. An
 *    extension -- one replacing a message at `message_end`, a custom
 *    provider, a tool-result hook -- can write any keys or block types there,
 *    and one that spread a data-keyed map onto a message, a content block, an
 *    entry or `usage` would have that map's identifier-shaped keys printed. So
 *    read the output before passing it on.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PreviewAssistantIdentity } from "../../src/server/sessions/preview-message.ts";
import { storedAgentMessage } from "../../src/server/sessions/preview-message.ts";

type Kind = "string" | "number" | "boolean" | "null" | "array" | "object";

function kindOf(value: unknown): Kind {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	const t = typeof value;
	return t === "string" || t === "number" || t === "boolean" ? t : "object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
function keyName(key: string): string {
	return KEY.test(key) ? key : "<non-identifier key>";
}

const DISCRIMINATOR = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
function discriminator(value: unknown): string {
	if (value === undefined) return "<none>";
	if (typeof value !== "string") return `<${kindOf(value)}>`;
	return DISCRIMINATOR.test(value) ? value : "<non-identifier>";
}

// pi-ai 1.2.0 `StopReason` and pi-agent-core 1.2.0 `ThinkingLevel`.
const STOP_REASONS = new Set(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function member(set: Set<string>, value: unknown): string {
	return typeof value === "string" && set.has(value) ? value : "<unlisted>";
}

/**
 * The printable value of an allowlisted field, or null for every other field.
 * `version` is the header's format number; `stopReason` and `thinkingLevel`
 * are what the preview's footer and effort label are built from, so a value
 * outside their unions is drift that reaches a client.
 */
function enumeratedValue(cls: Cls, key: string, value: unknown): string | null {
	if (cls === "header" && key === "version") {
		return Number.isInteger(value) ? String(value) : `<${kindOf(value)}>`;
	}
	if (cls === "message" && key === "stopReason") return member(STOP_REASONS, value);
	if ((cls === "message" || cls === "entry") && key === "thinkingLevel") return member(THINKING_LEVELS, value);
	return null;
}

type Cls = "header" | "entry" | "message" | "block" | "usage" | "cost" | "tool" | "toolRef" | "replacement";

interface Child {
	cls: Cls;
	array: boolean;
}

/**
 * Where the walk descends: the object-valued keys that hold Pi schema, per
 * class, and for entries per entry type (an unknown type gets its keys
 * surveyed and nothing below them). Everything absent here is not descended.
 */
const MESSAGE_CHILDREN: Record<string, Child> = {
	content: { cls: "block", array: true },
	usage: { cls: "usage", array: false },
	toolsAdded: { cls: "tool", array: true },
	toolsRemoved: { cls: "toolRef", array: true },
};
const ENTRY_CHILDREN: Record<string, Record<string, Child>> = {
	message: { message: { cls: "message", array: false } },
	usage: { usage: { cls: "usage", array: false } },
	compaction: { usage: { cls: "usage", array: false }, systemMessage: { cls: "message", array: false } },
	branch_summary: { usage: { cls: "usage", array: false } },
	custom_message: { content: { cls: "block", array: true } },
	context_edit: { replacement: { cls: "replacement", array: false } },
};
const DESCENT: Record<Exclude<Cls, "header" | "entry">, Record<string, Child>> = {
	message: MESSAGE_CHILDREN,
	usage: { cost: { cls: "cost", array: false } },
	replacement: { content: { cls: "block", array: true } },
	block: {},
	cost: {},
	tool: {},
	toolRef: {},
};

/**
 * Entry-level reads, kept by hand. Mirrors `parsePiSession` (its
 * `parseHeader` reads line 1, `extractUserMessageTexts` a message entry's
 * `type` and `message`) and `extractPiPreviewTurns` (its `extractPreviewTurn`
 * reads every later message entry's `type`, `timestamp` and `message`), both
 * in `src/server/sessions/pi.ts`. Neither reads any other entry type.
 */
const ENTRY_READS: { header: Record<string, string[]>; entry: Record<string, string[]> } = {
	header: { session: ["type", "cwd", "timestamp"] },
	entry: { message: ["type", "timestamp", "message"] },
};

// What `extractPreviewTurn` passes for a reply that names none of these.
const IDENTITY: PreviewAssistantIdentity = { api: "anthropic-messages", provider: "anthropic", model: "pi" };

interface PositionCensus {
	count: number;
	keys: Map<string, Map<string, number>>;
	values: Map<string, Map<string, number>>;
}

interface Tally {
	count: number;
	months: Set<string>;
}

const SECTIONS = [
	"entry types no reader reads",
	"messages storedAgentMessage drops whole",
	"content blocks storedAgentMessage drops",
	"keys carried to the wire unnamed, by a spread",
	"keys no reader reads, dropped",
] as const;
type Section = (typeof SECTIONS)[number];

/** `table[key]` for an own key only, so `toString` or `__proto__` finds nothing. */
function own<V>(table: Record<string, V>, key: unknown): V | undefined {
	return typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;
}

function bump<K>(map: Map<K, number>, key: K): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function inner<K, V>(map: Map<K, V>, key: K, make: () => V): V {
	let value = map.get(key);
	if (value === undefined) {
		value = make();
		map.set(key, value);
	}
	return value;
}

class Survey {
	files = 0;
	lines = 0;
	unparseable = 0;
	nonObject = 0;
	headerless = 0;
	readonly unreadableDirectories = new Map<string, number>();
	readonly unreadableFiles = new Map<string, number>();
	readonly census = new Map<string, Map<string, PositionCensus>>();
	readonly filesByMonth = new Map<string, number>();
	readonly offLineEntriesByMonth = new Map<string, number>();
	readonly offLineFilesByMonth = new Map<string, number>();
	readonly notRead = new Map<Section, Map<string, Tally>>();

	private tally(section: Section, item: string, month: string): void {
		const t = inner(inner(this.notRead, section, () => new Map<string, Tally>()), item, () => ({
			count: 0,
			months: new Set<string>(),
		}));
		t.count++;
		t.months.add(month);
	}

	private record(month: string, label: string, cls: Cls, obj: Record<string, unknown>): void {
		const pos = inner(inner(this.census, month, () => new Map<string, PositionCensus>()), label, () => ({
			count: 0,
			keys: new Map<string, Map<string, number>>(),
			values: new Map<string, Map<string, number>>(),
		}));
		pos.count++;
		for (const [key, value] of Object.entries(obj)) {
			bump(inner(pos.keys, keyName(key), () => new Map<string, number>()), kindOf(value));
			const printable = enumeratedValue(cls, key, value);
			if (printable !== null) bump(inner(pos.values, key, () => new Map<string, number>()), printable);
		}
	}

	/** Survey one object at a schema position, and its schema children. */
	private walk(month: string, label: string, cls: Cls, obj: Record<string, unknown>, children: Record<string, Child>): void {
		this.record(month, label, cls, obj);
		for (const [key, child] of Object.entries(children)) {
			const value = obj[key];
			if (child.array) {
				if (!Array.isArray(value)) continue;
				for (const item of value) {
					if (isRecord(item)) {
						const sub = child.cls === "block" ? `${label}.${key}[${discriminator(item.type)}]` : `${label}.${key}[]`;
						this.walk(month, sub, child.cls, item, DESCENT[child.cls as keyof typeof DESCENT]);
					} else {
						this.record(month, `${label}.${key}[<${kindOf(item)}>]`, child.cls, {});
					}
				}
			} else if (isRecord(value)) {
				const sub = child.cls === "message" && cls === "entry" && key === "message"
					? `message(${discriminator(value.role)})`
					: child.cls === "message"
						? `${label}.${key}(${discriminator(value.role)})`
						: `${label}.${key}`;
				this.walk(month, sub, child.cls, value, DESCENT[child.cls as keyof typeof DESCENT]);
			}
		}
	}

	private classifyEntry(month: string, label: string, table: Record<string, string[]>, entry: Record<string, unknown>): void {
		const reads = own(table, entry.type);
		if (!reads) {
			this.tally("entry types no reader reads", label, month);
			return;
		}
		for (const key of Object.keys(entry)) {
			if (!reads.includes(key)) this.tally("keys no reader reads, dropped", `${label}.${keyName(key)}`, month);
		}
	}

	/** Hand one message to the real `storedAgentMessage` and sort its keys. */
	private classifyMessage(month: string, message: Record<string, unknown>, timestamp: unknown): void {
		const label = `message(${discriminator(message.role)})`;
		const top = newAccess();
		const blocks: { label: string; access: Access; keys: string[] }[] = [];
		const target: Record<string, unknown> = { ...message };
		if (Array.isArray(message.content)) {
			target.content = message.content.map((block, index) => {
				if (!isRecord(block)) return block;
				const access = newAccess();
				blocks[index] = { label: `${label}.content[${discriminator(block.type)}]`, access, keys: Object.keys(block) };
				return instrument({ ...block, [BLOCK_INDEX]: index }, access);
			});
		}
		const turn = storedAgentMessage(
			instrument(target, top),
			typeof timestamp === "string" ? timestamp : undefined,
			IDENTITY,
		) as Record<string | symbol, unknown> | null;
		if (turn === null) {
			this.tally("messages storedAgentMessage drops whole", label, month);
			return;
		}
		for (const key of Object.keys(message)) this.classifyKey(month, `${label}.${keyName(key)}`, key, top, turn);
		const survivors = new Map<number, Record<string | symbol, unknown>>();
		if (Array.isArray(turn.content)) {
			for (const block of turn.content) {
				if (isRecord(block) && typeof (block as Record<symbol, unknown>)[BLOCK_INDEX] === "number") {
					survivors.set((block as Record<symbol, unknown>)[BLOCK_INDEX] as number, block);
				}
			}
		}
		blocks.forEach((block, index) => {
			const out = survivors.get(index);
			if (!out) {
				this.tally("content blocks storedAgentMessage drops", block.label, month);
				return;
			}
			for (const key of block.keys) this.classifyKey(month, `${block.label}.${keyName(key)}`, key, block.access, out);
		});
	}

	private classifyKey(month: string, item: string, key: string, access: Access, out: Record<string | symbol, unknown>): void {
		if (access.named.has(key)) return;
		if (access.copied.has(key) && Object.hasOwn(out, key)) {
			this.tally("keys carried to the wire unnamed, by a spread", item, month);
		} else {
			this.tally("keys no reader reads, dropped", item, month);
		}
	}

	/** Survey one file, if its line 1 is a Pi session header; count it if not. */
	addFile(text: string, month: string): void {
		const lines = text.split("\n").filter((line) => line.length > 0);
		const header = parseLine(lines[0]);
		if (!isRecord(header) || header.type !== "session") {
			this.headerless++;
			return;
		}
		this.files++;
		bump(this.filesByMonth, month);
		let previousId: unknown;
		let offLine = 0;
		lines.forEach((line, index) => {
			this.lines++;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				this.unparseable++;
				return;
			}
			if (!isRecord(parsed)) {
				this.nonObject++;
				return;
			}
			const type = discriminator(parsed.type);
			if (index === 0) {
				const label = `header(${type})`;
				this.walk(month, label, "header", parsed, {});
				this.classifyEntry(month, label, ENTRY_READS.header, parsed);
				return;
			}
			if (index >= 2 && parsed.parentId !== previousId) offLine++;
			previousId = parsed.id;
			const label = `entry(${type})`;
			const children = own(ENTRY_CHILDREN, parsed.type) ?? {};
			this.walk(month, label, "entry", parsed, children);
			this.classifyEntry(month, label, ENTRY_READS.entry, parsed);
			if (parsed.type === "message" && isRecord(parsed.message)) {
				this.classifyMessage(month, parsed.message, parsed.timestamp);
			}
		});
		if (offLine > 0) {
			this.offLineEntriesByMonth.set(month, (this.offLineEntriesByMonth.get(month) ?? 0) + offLine);
			bump(this.offLineFilesByMonth, month);
		}
	}

	report(): string {
		const out: string[] = [];
		const months = [...this.filesByMonth.keys()].sort();
		out.push("Pi session store survey: structure only, never content (resources/probes/pi_store_survey.ts).");
		out.push(
			`session files ${this.files}, lines ${this.lines}, unparseable lines ${this.unparseable}, non-object lines ${this.nonObject}`,
		);
		out.push(
			`skipped: files without a Pi session header ${this.headerless}, unreadable directories ${failures(this.unreadableDirectories)}, unreadable files ${failures(this.unreadableFiles)}`,
		);
		out.push("");
		out.push("== Census, by UTC month of file mtime ==");
		for (const month of months) {
			out.push("");
			out.push(
				`-- ${month}: ${this.filesByMonth.get(month)} files; ${this.offLineEntriesByMonth.get(month) ?? 0} entries not parented on the line before, in ${this.offLineFilesByMonth.get(month) ?? 0} files --`,
			);
			const positions = this.census.get(month) ?? new Map<string, PositionCensus>();
			for (const label of [...positions.keys()].sort()) {
				const pos = positions.get(label)!;
				out.push(`${label}  ${pos.count}`);
				for (const key of [...pos.keys.keys()].sort()) {
					out.push(`  ${key}: ${formatCounts(pos.keys.get(key)!)}`);
				}
				for (const key of [...pos.values.keys()].sort()) {
					out.push(`  ${key} = ${formatCounts(pos.values.get(key)!)}`);
				}
			}
		}
		out.push("");
		out.push("== Not read by agentpane ==");
		out.push("Entry level: parsePiSession and extractPiPreviewTurns (src/server/sessions/pi.ts), hand-kept as ENTRY_READS.");
		out.push("Message and block level: storedAgentMessage (src/server/sessions/preview-message.ts), measured by calling it.");
		out.push("Objects below a message or block (usage, toolsAdded[], ...) go wherever their parent key goes.");
		for (const section of SECTIONS) {
			out.push("");
			out.push(`-- ${section} --`);
			const items = this.notRead.get(section);
			if (!items || items.size === 0) {
				out.push("  (none)");
				continue;
			}
			for (const item of [...items.keys()].sort()) {
				const t = items.get(item)!;
				const seen = [...t.months].sort();
				const span = seen.length === 1 ? seen[0] : `${seen[0]}..${seen[seen.length - 1]}`;
				out.push(`  ${item}  ${t.count}  [${span}]`);
			}
		}
		return `${out.join("\n")}\n`;
	}
}

/** A count of failures, and their error codes when there are any. */
function failures(codes: Map<string, number>): string {
	let total = 0;
	for (const n of codes.values()) total += n;
	return total === 0 ? "0" : `${total} (${formatCounts(codes)})`;
}

function parseLine(line: string | undefined): unknown {
	if (line === undefined) return undefined;
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/**
 * A filesystem error's code, such as `EACCES`, and never its message, which
 * names the path: under a Pi store root that is the encoding of a project's
 * working directory.
 */
function errorCode(error: unknown): string {
	const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	return typeof code === "string" && /^E[A-Z0-9]{1,15}$/.test(code) ? code : "other";
}

function formatCounts(counts: Map<string, number>): string {
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([value, n]) => `${value} ${n}`)
		.join(", ");
}

interface Access {
	named: Set<string>;
	copied: Set<string>;
}

function newAccess(): Access {
	return { named: new Set(), copied: new Set() };
}

const BLOCK_INDEX = Symbol("block index");

/**
 * A view of `target` that records how each string key is read: a read just
 * after its own descriptor read is a spread's copy, any other read is named.
 */
function instrument<T extends object>(target: T, access: Access): T {
	const described = new Set<PropertyKey>();
	return new Proxy(target, {
		getOwnPropertyDescriptor(t, key) {
			described.add(key);
			return Reflect.getOwnPropertyDescriptor(t, key);
		},
		get(t, key, receiver) {
			const copied = described.delete(key);
			if (typeof key === "string") (copied ? access.copied : access.named).add(key);
			return Reflect.get(t, key, receiver);
		},
		has(t, key) {
			if (typeof key === "string") access.named.add(key);
			return Reflect.has(t, key);
		},
	});
}

/** Every `*.jsonl` under `dir`, counting each directory it cannot list by its error code. */
function jsonlFiles(dir: string, unreadable: Map<string, number>): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		bump(unreadable, errorCode(error));
		return [];
	}
	const found: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...jsonlFiles(path, unreadable));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
	}
	return found;
}

/** The root itself could not be listed; its message names the error code and not the path. */
export class StoreRootError extends Error {}

/**
 * The survey of every Pi session file under `root`, as printable text. A
 * directory or file it cannot read is counted by error code and skipped; a
 * root it cannot list throws `StoreRootError`.
 */
export function surveyPiStore(root: string): string {
	try {
		readdirSync(root);
	} catch (error) {
		throw new StoreRootError(`cannot read the store root (${errorCode(error)})`);
	}
	const survey = new Survey();
	for (const path of jsonlFiles(root, survey.unreadableDirectories).sort()) {
		let month: string;
		let text: string;
		try {
			month = statSync(path).mtime.toISOString().slice(0, 7);
			text = readFileSync(path, "utf8");
		} catch (error) {
			bump(survey.unreadableFiles, errorCode(error));
			continue;
		}
		survey.addFile(text, month);
	}
	return survey.report();
}

if (import.meta.main) {
	const root = process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions");
	try {
		process.stdout.write(surveyPiStore(root));
	} catch (error) {
		if (!(error instanceof StoreRootError)) throw error;
		console.error(`pi_store_survey: ${error.message}`);
		process.exit(1);
	}
}
