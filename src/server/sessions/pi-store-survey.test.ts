/**
 * The Pi store survey probe (`resources/probes/pi_store_survey.ts`,
 * OW-tadoju) runs on the owner's real stores and its output is pasted back,
 * so what it must never do is print content. These run it on synthetic
 * stores: one seeded with a single marker string in every content-bearing
 * position, and one whose drift the "Not read by agentpane" section must name.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { surveyPiStore } from "../../../resources/probes/pi_store_survey.ts";

const MARK = "zqxjmark";

const roots: string[] = [];
const locked: string[] = [];
afterEach(() => {
	for (const path of locked.splice(0)) chmodSync(path, 0o700);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(files: Record<string, unknown[]>, raw: string[] = []): string {
	const root = mkdtempSync(join(tmpdir(), "pi-store-survey-"));
	roots.push(root);
	for (const [name, entries] of Object.entries(files)) {
		const path = join(root, name);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, [...entries.map((e) => JSON.stringify(e)), ...raw].join("\n") + "\n");
		const when = new Date("2026-10-14T12:00:00Z");
		utimesSync(path, when, when);
	}
	return root;
}

const base = (n: number) => ({ id: `${MARK}-${n}`, parentId: `${MARK}-${n - 1}`, timestamp: "2026-10-14T12:00:00Z" });

/** One marker in every position that holds a value, a name, or a data map's key. */
function markedEntries(): unknown[] {
	const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const message = (n: number, msg: Record<string, unknown>) => ({ type: "message", ...base(n), message: { timestamp: 1, ...msg } });
	return [
		{ type: "session", version: 3, id: MARK, timestamp: MARK, cwd: `/home/${MARK}/project`, parentSession: `/${MARK}/parent.jsonl` },
		message(1, {
			role: "user",
			content: [{ type: "text", text: MARK }, { type: "image", data: MARK, mimeType: `image/${MARK}` }],
			unknownField: MARK,
		}),
		message(2, { role: "user", content: MARK }),
		message(3, {
			role: "assistant",
			content: [
				{ type: "text", text: MARK, textSignature: MARK },
				{ type: "thinking", thinking: MARK, thinkingSignature: MARK },
				{ type: "toolCall", id: MARK, name: MARK, arguments: { [MARK]: MARK, nested: { [`${MARK}Key`]: MARK } } },
			],
			api: MARK,
			provider: MARK,
			model: MARK,
			responseId: MARK,
			responseModel: MARK,
			rawStopReason: MARK,
			stopReason: MARK,
			thinkingLevel: MARK,
			errorMessage: MARK,
			usage,
		}),
		message(4, {
			role: "toolResult",
			toolCallId: MARK,
			toolName: MARK,
			content: [{ type: "text", text: MARK }],
			details: { [MARK]: MARK, diff: MARK },
			isError: false,
		}),
		message(5, {
			role: "system",
			content: MARK,
			sections: { [MARK]: MARK, rules: MARK },
			toolsAdded: [{ name: MARK, description: MARK, parameters: { type: "object", properties: { [MARK]: { type: "string", description: MARK } } } }],
			toolsRemoved: [{ name: MARK }],
		}),
		message(6, { role: "bashExecution", command: MARK, output: MARK, exitCode: 0, cancelled: false, truncated: false, fullOutputPath: `/${MARK}` }),
		message(7, { role: "compactionSummary", summary: MARK, tokensBefore: 10 }),
		message(8, { role: "custom", customType: MARK, content: MARK, display: true, details: { [MARK]: MARK } }),
		message(9, { role: `${MARK} not an identifier`, content: MARK }),
		message(10, { role: "assistant", content: [{ type: `${MARK}!`, [`${MARK} key`]: MARK }], usage }),
		{ type: "custom_message", ...base(11), customType: MARK, content: [{ type: "text", text: MARK }], details: { [MARK]: MARK }, display: true },
		{ type: "custom", ...base(12), customType: MARK, data: { [MARK]: { [`${MARK}Inner`]: MARK } } },
		{
			type: "compaction",
			...base(13),
			summary: MARK,
			firstKeptEntryId: MARK,
			tokensBefore: 10,
			details: { [MARK]: MARK },
			usage,
			systemMessage: { role: "system", content: MARK, sections: { [MARK]: MARK }, timestamp: 1 },
		},
		{ type: "branch_summary", ...base(14), fromId: MARK, summary: MARK, details: { [MARK]: MARK } },
		{ type: "label", ...base(15), targetId: MARK, label: MARK },
		{ type: "session_info", ...base(16), name: MARK },
		{ type: "model_change", ...base(17), provider: MARK, modelId: MARK },
		{ type: "thinking_level_change", ...base(18), thinkingLevel: MARK },
		{ type: "usage", ...base(19), kind: MARK, provider: MARK, model: MARK, usage, note: MARK },
		{ type: "context_edit", ...base(20), targetId: MARK, replacement: { content: [{ type: "text", text: MARK }] } },
		{ type: "future_entry", ...base(21), payload: { [MARK]: MARK, list: [{ [MARK]: MARK }] } },
		{ type: `${MARK} spaced`, ...base(22) },
	];
}

describe("pi_store_survey", () => {
	it("prints no value, name or data-map key from anywhere in the store", () => {
		const root = store(
			{
				[`--home-${MARK}-project--/2026-10-14T12-00-00_${MARK}.jsonl`]: markedEntries(),
				[`${MARK}/second_${MARK}.jsonl`]: [{ type: "message", ...base(1), message: { role: "user", content: MARK } }],
				// Not a Pi session: its line 1 names no session, so nothing in it is walked.
				[`notes/${MARK}.jsonl`]: [{ type: `${MARK}Type`, version: 7777, [`${MARK}Key`]: { [`${MARK}Inner`]: 1 } }],
			},
			[`{"broken": "${MARK}`, JSON.stringify(MARK)],
		);

		const output = surveyPiStore(root);
		expect(output.toLowerCase()).not.toContain(MARK);
		expect(output).not.toContain(root);

		// It walked every position the marker sits in, so its silence is earned.
		for (const position of [
			"header(session)",
			"message(assistant).content[toolCall]",
			"message(toolResult)",
			"message(system).toolsAdded[]",
			"message(system).toolsRemoved[]",
			"message(bashExecution)",
			"entry(custom)",
			"entry(custom_message).content[text]",
			"entry(compaction).systemMessage(system)",
			"entry(usage).usage.cost",
			"entry(context_edit).replacement.content[text]",
			"entry(future_entry)",
			"entry(<non-identifier>)",
			"message(<non-identifier>)",
			"message(assistant).content[<non-identifier>]",
		]) {
			expect(output).toContain(`${position}  `);
		}
		expect(output).toContain("<non-identifier key>");
		expect(output).toContain("stopReason = <unlisted> 1");
		expect(output).toContain("unparseable lines 1");
		expect(output).toContain("files without a Pi session header 2");
		expect(output).not.toContain("7777");
	});

	it.skipIf(process.getuid?.() === 0)("counts what it cannot read, names none of it, and reports the rest", () => {
		const header = { type: "session", version: 3, id: "s", timestamp: "2026-10-14T12:00:00Z", cwd: "/w" };
		const root = store({
			"open/one.jsonl": [header, { type: "message", ...base(1), message: { role: "user", content: "hi", timestamp: 1 } }],
			[`${MARK}-dir/inside.jsonl`]: [header],
			[`open/${MARK}.jsonl`]: [header],
		});
		for (const path of [join(root, `${MARK}-dir`), join(root, "open", `${MARK}.jsonl`)]) {
			chmodSync(path, 0);
			locked.push(path);
		}

		const output = surveyPiStore(root);

		expect(output.toLowerCase()).not.toContain(MARK);
		expect(output).not.toContain(root);
		expect(output).toContain("unreadable directories 1 (EACCES 1)");
		expect(output).toContain("unreadable files 1 (EACCES 1)");
		expect(output).toContain("message(user)  1");
	});

	it("refuses a root it cannot read without naming it", () => {
		const missing = join(tmpdir(), `${MARK}-no-such-store`);
		expect(() => surveyPiStore(missing)).toThrow(/^cannot read the store root \(ENOENT\)$/);
	});

	it("lists what agentpane's readers drop or carry unnamed, and not what they read", () => {
		const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const root = store({
			"a/one.jsonl": [
				{ type: "session", version: 3, id: "s", timestamp: "2026-10-14T12:00:00Z", cwd: "/w" },
				{ type: "message", ...base(1), message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1, futureUserField: 1 } },
				{
					type: "message",
					...base(2),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "a", futureTextField: 1 }, { type: "futureBlock", x: 1 }],
						futureAssistantField: 1,
						usage,
						stopReason: "stop",
						timestamp: 1,
					},
				},
				{ type: "message", ...base(3), message: { role: "futureRole", content: [] } },
				{ type: "future_entry", ...base(4) },
				// Entry types that are also Object.prototype's own keys.
				{ type: "toString", ...base(5) },
				{ type: "constructor", ...base(6) },
				{ type: "__proto__", ...base(7) },
			],
			// The third message starts a branch off the first.
			"b/two.jsonl": [
				{ type: "session", version: 3, id: "t", timestamp: "2026-10-14T12:00:00Z", cwd: "/w" },
				...[1, 2, 3].map((n) => ({
					type: "message",
					...base(n),
					...(n === 3 ? { parentId: base(1).id } : {}),
					message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
				})),
			],
		});

		const output = surveyPiStore(root);
		const section = (name: string) => {
			const start = output.indexOf(`-- ${name} --\n`);
			expect(start).toBeGreaterThanOrEqual(0);
			const rest = output.slice(start).split("\n").slice(1);
			const end = rest.findIndex((line) => !line.startsWith("  "));
			return rest.slice(0, end).map((line) => line.trim().split(/\s+/)[0]);
		};

		expect(output).toContain("-- 2026-10: 2 files; 1 entries not parented on the line before, in 1 files --");
		expect(section("entry types no reader reads")).toEqual([
			"entry(<non-identifier>)",
			"entry(constructor)",
			"entry(future_entry)",
			"entry(toString)",
		]);
		expect(section("messages storedAgentMessage drops whole")).toEqual(["message(futureRole)"]);
		expect(section("content blocks storedAgentMessage drops")).toEqual(["message(assistant).content[futureBlock]"]);
		expect(section("keys carried to the wire unnamed, by a spread")).toEqual([
			"message(assistant).content[text].futureTextField",
			"message(assistant).futureAssistantField",
		]);
		expect(section("keys no reader reads, dropped")).toEqual([
			"entry(message).id",
			"entry(message).parentId",
			"header(session).id",
			"header(session).version",
			"message(user).futureUserField",
			"message(user).timestamp",
		]);
	});
});
