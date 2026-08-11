/**
 * Test-only helpers for driving the Codex adapter from recorded fixtures.
 *
 * Not a test file (vitest only collects `*.test.ts`), and nothing in the
 * shipping path imports it. It exists so the reducer tests and the adapter
 * tests read the same recordings the same way.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	isCodexResponse,
	isRecord,
	type CodexResponse,
	type CodexServerMessage,
	type ThreadItem,
} from "./protocol.ts";

export type FixtureName = "text" | "tool-read" | "tool-edit";

const FIXTURE_DIR = fileURLToPath(new URL("../../../../resources/fixtures/codex/", import.meta.url));

export interface FixtureMeta {
	lines: number;
	event_census: Record<string, number>;
	server_requests_seen: string[];
}

type ServerPushedMessage = Exclude<CodexServerMessage, CodexResponse>;
type CodexMethod = ServerPushedMessage["method"];

/** Every line of a recorded turn, parsed, in order. */
export function readFixture(name: FixtureName): CodexServerMessage[] {
	const text = readFileSync(`${FIXTURE_DIR}${name}.jsonl`, "utf8");
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed)) throw new Error(`${name}.jsonl:${index + 1} is not an object`);
			// Captures are versioned alongside the generated bindings and are the
			// adapter's behavioral source. The cast stays at this one fixture seam.
			return parsed as CodexServerMessage;
		});
}

/** The provenance file next to each recording (CLI version, event census). */
export function readFixtureMeta(name: FixtureName): FixtureMeta {
	return JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.meta.json`, "utf8")) as FixtureMeta;
}

/** Lines the server pushed at us: notifications and blocking `ServerRequest`s. */
export function serverMessages(lines: CodexServerMessage[]): ServerPushedMessage[] {
	return lines.filter((line): line is ServerPushedMessage => "method" in line);
}

/** Responses to the capture harness's own requests, in the order it made them. */
export function recordedResults(lines: CodexServerMessage[]): unknown[] {
	return lines.filter(isCodexResponse).map((line) => line.result);
}

/** Find recorded events by method, e.g. every `item/completed`. */
export function byMethod<M extends CodexMethod>(
	lines: CodexServerMessage[],
	method: M,
): Extract<ServerPushedMessage, { method: M }>[] {
	return lines.filter(
		(line): line is Extract<ServerPushedMessage, { method: M }> =>
			"method" in line && line.method === method,
	);
}

export function itemOf(
	line: Extract<ServerPushedMessage, { method: "item/started" | "item/completed" }>,
): ThreadItem {
	return line.params.item;
}

/**
 * A `CodexProcess` that never spawns anything.
 *
 * `onWrite` sees everything the adapter sends; `emit` pushes a line back as if
 * app-server had written it. That is the whole seam -- the adapter cannot tell
 * the difference, so an entire recorded turn replays through the real client,
 * reducer, and listener plumbing offline.
 */
export class FakeCodexProcess {
	readonly written: Record<string, unknown>[] = [];
	killed = false;

	private lineHandlers: ((line: string) => void)[] = [];
	private exitHandlers: ((code: number | null, signal: string | null) => void)[] = [];
	private writeHandlers: ((message: Record<string, unknown>) => void)[] = [];

	write(line: string): void {
		const message = JSON.parse(line) as Record<string, unknown>;
		this.written.push(message);
		for (const handler of [...this.writeHandlers]) handler(message);
	}

	onLine(cb: (line: string) => void): void {
		this.lineHandlers.push(cb);
	}

	onExit(cb: (code: number | null, signal: string | null) => void): void {
		this.exitHandlers.push(cb);
	}

	kill(): void {
		this.killed = true;
	}

	/** Called for every message the adapter writes. */
	onWrite(cb: (message: Record<string, unknown>) => void): void {
		this.writeHandlers.push(cb);
	}

	emit(message: unknown): void {
		const line = JSON.stringify(message);
		for (const handler of [...this.lineHandlers]) handler(line);
	}

	exit(code: number | null = 0, signal: string | null = null): void {
		for (const handler of [...this.exitHandlers]) handler(code, signal);
	}

	/** The last request the adapter sent for `method`, if any. */
	lastRequest(method: string): Record<string, unknown> | undefined {
		return [...this.written].reverse().find((message) => message["method"] === method);
	}
}
