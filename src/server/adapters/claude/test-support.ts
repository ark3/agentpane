/**
 * Test-only helpers for driving the Claude adapter from recorded fixtures.
 *
 * Not a test file (vitest only collects `*.test.ts`); nothing in the shipping
 * path imports it. The reducer tests and the adapter tests read the same
 * recordings the same way.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asClaudeEvent, isRecord, type ClaudeEvent } from "./protocol.ts";

export type FixtureName =
	| "text-turn"
	| "thinking"
	| "tool-use"
	| "compact"
	| "interrupt"
	| "fork"
	| "fork-at-message"
	| "session-id"
	| "control-discovery"
	| "permission-request";

const FIXTURE_DIR = fileURLToPath(
	new URL("../../../../resources/fixtures/claude/", import.meta.url),
);

export interface FixtureMeta {
	lines: number;
	event_census: Record<string, number>;
	session_id: string;
}

/** Every line of a recorded session, parsed, in order. */
export function readFixture(name: FixtureName): ClaudeEvent[] {
	const text = readFileSync(`${FIXTURE_DIR}${name}.jsonl`, "utf8");
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			const event = asClaudeEvent(JSON.parse(line));
			if (!event) throw new Error(`${name}.jsonl:${index + 1} is not a claude event`);
			return event;
		});
}

/** The provenance file next to each recording (CLI version, event census). */
export function readFixtureMeta(name: FixtureName): FixtureMeta {
	return JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.meta.json`, "utf8")) as FixtureMeta;
}

/** The census key a fixture line falls under, matching the capture harness. */
export function censusKey(event: ClaudeEvent): string {
	if (event.type === "system") {
		return `system:${(event as { subtype?: string }).subtype ?? "?"}`;
	}
	if (event.type === "stream_event") {
		const body = (event as { event?: { type?: string } }).event;
		return `stream_event:${body?.type ?? "?"}`;
	}
	return event.type;
}

/** All `assistant` events in the recording, in order. */
export function assistantEvents(
	lines: ClaudeEvent[],
): Extract<ClaudeEvent, { type: "assistant" }>[] {
	return lines.filter(
		(line): line is Extract<ClaudeEvent, { type: "assistant" }> => line.type === "assistant",
	);
}

/** The distinct API `message.id`s of the recording's assistant events. */
export function assistantMessageIds(lines: ClaudeEvent[]): string[] {
	const ids: string[] = [];
	for (const event of assistantEvents(lines)) {
		const id = event.message?.id;
		if (typeof id === "string" && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** Authoritative blocks of one type across a recording's assistant events. */
export function authoritativeBlocks(lines: ClaudeEvent[], type: string): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const event of assistantEvents(lines)) {
		const content = event.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (isRecord(block) && block.type === type) out.push(block);
		}
	}
	return out;
}

/**
 * A `ClaudeProcess` that never spawns anything. `written` sees every line the
 * adapter sends; `emit` pushes an event back as if the CLI had written it.
 */
export class FakeClaudeProcess {
	readonly written: Record<string, unknown>[] = [];
	killed = false;
	killCount = 0;

	private lineHandlers: ((line: string) => void)[] = [];
	private exitHandlers: ((code: number | null, signal: string | null, error?: Error) => void)[] =
		[];

	write(line: string): void {
		if (this.killed) throw new Error("Claude Code process is not running");
		this.written.push(JSON.parse(line) as Record<string, unknown>);
	}

	onLine(cb: (line: string) => void): void {
		this.lineHandlers.push(cb);
	}

	onExit(cb: (code: number | null, signal: string | null, error?: Error) => void): void {
		this.exitHandlers.push(cb);
	}

	kill(): Promise<void> {
		this.killed = true;
		this.killCount += 1;
		return Promise.resolve();
	}

	emit(message: unknown): void {
		const line = JSON.stringify(message);
		for (const handler of [...this.lineHandlers]) handler(line);
	}

	exit(code: number | null = 0, signal: string | null = null, error?: Error): void {
		for (const handler of [...this.exitHandlers]) handler(code, signal, error);
	}

	/** The last user-message line the adapter wrote, if any. */
	lastUserMessage(): Record<string, unknown> | undefined {
		return [...this.written].reverse().find((message) => message.type === "user");
	}

	/** The last control_request of `subtype` the adapter wrote, if any. */
	lastControlRequest(subtype: string): Record<string, unknown> | undefined {
		return [...this.written]
			.reverse()
			.find(
				(message) =>
					message.type === "control_request" &&
					isRecord(message.request) &&
					message.request.subtype === subtype,
			);
	}
}
