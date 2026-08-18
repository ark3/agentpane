/**
 * Message chrome and the transcript list.
 *
 * The load-bearing behaviour here is D3's: the server upserts the *tail*
 * message by index during a turn, so the list has to survive that without
 * throwing away and rebuilding the DOM it already has.
 */
import { render } from "@testing-library/svelte";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../time.ts";
import { previewMessages } from "../preview.ts";
import Message from "./Message.svelte";
import Transcript from "./Transcript.svelte";
import { assistant, errors, everything, orphanResult, streamingTurn, toolRead, user } from "./samples.ts";

const roles = (container: HTMLElement) =>
	[...container.querySelectorAll("article")].map((el) => el.dataset.role);

/** What the session list renders: ISO to the second, UTC, no sub-second part. */
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

describe("Message", () => {
	it("gives each role its own chrome", () => {
		expect(roles(render(Message, { props: { message: user("hi") } }).container)).toEqual(["user"]);
		expect(
			roles(render(Message, { props: { message: assistant([{ type: "text", text: "yo" }]) } }).container),
		).toEqual(["assistant"]);
	});

	it("renders no role label for a user turn", () => {
		// The filled surface and accent border on .user already mark a user
		// turn as the reader's own (OW-52); the word "You" is redundant.
		const { container } = render(Message, { props: { message: user("hi") } });
		expect(container.querySelector(".who")).toBeNull();
		expect(container.textContent).not.toContain("You");
	});

	it("accepts a user message whose content is a bare string", () => {
		// UserMessage.content is `string | blocks[]` in pi-ai; both are real.
		const { container } = render(Message, {
			props: { message: { role: "user", content: "plain string", timestamp: 1 } },
		});
		expect(container.querySelector(".markdown")?.textContent).toContain("plain string");
	});

	it("shows the model and token cost of a finished turn", () => {
		const { container } = render(Message, {
			props: { message: assistant([{ type: "text", text: "done" }]) },
		});
		const meta = container.querySelector(".meta")?.textContent ?? "";
		expect(meta).toContain("example-model");
		expect(meta).toMatch(/\d+\s*tok/);
	});

	it("still names the model of a finished turn that reports no usage", () => {
		// A synthesised preview turn (OW-50) has no usage, and neither does a real
		// turn whose provider reported none -- the model is known either way.
		const { container } = render(Message, {
			props: {
				message: assistant([{ type: "text", text: "done" }], "stop", {
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			},
		});
		const meta = container.querySelector(".meta")?.textContent ?? "";
		expect(meta).toContain("example-model");
		expect(meta).not.toMatch(/tok/);
	});

	it("shows the reasoning effort beside the model when the backend reported one", () => {
		// Codex answers `thread/start`/`thread/resume` with `reasoningEffort`;
		// nothing in this UI can change it mid-session, so the turn carries it.
		const { container } = render(Message, {
			props: { message: { ...assistant([{ type: "text", text: "done" }]), effort: "high" } },
		});
		const spans = [...(container.querySelector(".meta")?.querySelectorAll("span") ?? [])].map(
			(el) => el.textContent,
		);
		expect(spans).toContain("example-model");
		expect(spans).toContain("high");
	});

	it("names only the model when no effort was reported", () => {
		// Pi reports no effort at all, so the absent case is the common one: no
		// placeholder, no "unknown", nothing extra in the meta line. The row's
		// timestamp (OW-67) is a <time>, not a <span>, so it is not in this list.
		const { container } = render(Message, {
			props: { message: assistant([{ type: "text", text: "done" }]) },
		});
		const spans = [...(container.querySelector(".meta")?.querySelectorAll("span") ?? [])].map(
			(el) => el.textContent,
		);
		expect(spans).toEqual(["example-model", expect.stringMatching(/tok$/)]);
	});

	it("stamps a finished turn with when it happened, in the session list's format", () => {
		// Absolute, not relative (OW-67): nothing here ticks, and the string is
		// the shared formatter's, so the transcript and the session list agree.
		const message = assistant([{ type: "text", text: "done" }]);
		const { container } = render(Message, { props: { message } });
		const time = container.querySelector(".meta time");
		expect(time?.textContent?.trim()).toMatch(STAMP);
		expect(time?.textContent?.trim()).toBe(formatTimestamp(message.timestamp));
		expect(time?.getAttribute("datetime")).toBe(new Date(message.timestamp).toISOString());
	});

	it("puts a user turn's time in its block action row, the only chrome it has", () => {
		const message = user("hi");
		const { container } = render(Message, { props: { message } });
		const time = container.querySelector("[data-block-actions='text'] time");
		expect(time?.textContent?.trim()).toBe(formatTimestamp(message.timestamp));
	});

	it("does not stamp an assistant's text block, which already has a meta row", () => {
		// The action row is per-block and every role has one; only the user arm
		// hands it a time, or a turn would carry the same stamp twice.
		const { container } = render(Message, {
			props: { message: assistant([{ type: "text", text: "done" }]) },
		});
		expect(container.querySelector("[data-block-actions] time")).toBeNull();
	});

	it("shows no cost while the turn is still pending", () => {
		const { container } = render(Message, {
			props: { message: assistant([{ type: "text", text: "..." }], "pending") },
		});
		expect(container.querySelector(".meta")).toBeNull();
	});

	it("reports the provider's own error text when a turn fails", () => {
		const { container } = render(Message, {
			props: { message: assistant([], "error", { errorMessage: "provider returned 500" }) },
		});
		expect(container.querySelector(".banner.error")?.textContent).toContain("provider returned 500");
	});

	it("says a turn was aborted", () => {
		const { container } = render(Message, {
			props: { message: assistant([], "aborted") },
		});
		expect(container.querySelector(".banner.aborted")).not.toBeNull();
	});

	it("falls back to a readable dump for a message kind it does not know", () => {
		// `AgentMessage` is open by construction -- a backend can merge in new
		// kinds -- so the else branch is reachable, not dead code.
		const { container } = render(Message, {
			props: { message: { role: "compaction", summary: "squashed" } as unknown as AgentMessage },
		});
		expect(roles(container)).toEqual(["unknown"]);
		expect(container.textContent).toContain("compaction");
	});

	it("renders a compactionSummary as its own marker, not the unknown dump (OW-72)", () => {
		// One renderer for both backends. The marker must not fall through to the
		// unknown JSON dump -- that is the whole point of the branch.
		const { container } = render(Message, {
			props: {
				message: { role: "compactionSummary", summary: "folded history", tokensBefore: 17660, timestamp: 1 } as unknown as AgentMessage,
			},
		});
		expect(roles(container)).toEqual(["compactionSummary"]);
		expect(roles(container)).not.toContain("unknown");
		// Pi supplies a summary and a token figure: both are shown.
		expect(container.querySelector(".compaction-marker")).not.toBeNull();
		expect(container.textContent).toContain("folded history");
		expect(container.querySelector(".compaction-tokens")?.textContent).toMatch(/18K/);
	});

	it("renders a bare compactionSummary marker with no summary and no token figure (OW-72)", () => {
		// Codex's contextCompaction carries neither: still a marker, but no body
		// and no token figure. Same renderer, same data-role -- just empty fields.
		const { container } = render(Message, {
			props: {
				message: { role: "compactionSummary", summary: "", tokensBefore: 0, timestamp: 1 } as unknown as AgentMessage,
			},
		});
		expect(roles(container)).toEqual(["compactionSummary"]);
		expect(container.querySelector(".compaction-marker")).not.toBeNull();
		expect(container.querySelector(".compaction-tokens")).toBeNull();
		expect(container.querySelector(".body")).toBeNull();
	});
});

describe("preview timestamps (OW-71)", () => {
	it("renders a preview turn's real time, converted from the wire's ISO string", () => {
		// The turn carries the record's ISO string; `previewMessages` converts it
		// to epoch-ms at the client edge, and the shared formatter renders it.
		const iso = "2026-06-05T18:25:00.147Z";
		const assistantMsg = previewMessages([{ role: "assistant", text: "hi", timestamp: iso }], "pi")[0]!;
		const { container } = render(Message, { props: { message: assistantMsg } });
		const time = container.querySelector(".meta time");
		expect(time?.textContent?.trim()).toMatch(STAMP);
		expect(time?.textContent?.trim()).toBe(formatTimestamp(iso));
	});

	it("puts a preview user turn's real time in its block action row", () => {
		const iso = "2026-06-05T18:25:00.147Z";
		const userMsg = previewMessages([{ role: "user", text: "hi", timestamp: iso }], "pi")[0]!;
		const { container } = render(Message, { props: { message: userMsg } });
		const time = container.querySelector("[data-block-actions='text'] time");
		expect(time?.textContent?.trim()).toMatch(STAMP);
		expect(time?.textContent?.trim()).toBe(formatTimestamp(iso));
	});

	it("renders no time at all for a preview turn that carries none", () => {
		// The genuinely-absent case: no wire timestamp maps to NaN at the edge,
		// which the formatter renders as empty -- no <time>, not the epoch.
		const assistantMsg = previewMessages([{ role: "assistant", text: "hi" }], "pi")[0]!;
		const { container } = render(Message, { props: { message: assistantMsg } });
		expect(container.querySelector(".meta time")).toBeNull();
		expect(container.textContent).not.toContain("1970");
	});

	it("renders no time for an absent-timestamp user turn either", () => {
		const userMsg = previewMessages([{ role: "user", text: "hi" }], "pi")[0]!;
		const { container } = render(Message, { props: { message: userMsg } });
		expect(container.querySelector("[data-block-actions='text'] time")).toBeNull();
		expect(container.textContent).not.toContain("1970");
	});
});

describe("Transcript", () => {
	it("folds a tool result into the call it answers", () => {
		const { container } = render(Transcript, { props: { messages: toolRead } });
		// user, assistant(with the call), assistant -- the result is inside the card.
		expect(roles(container)).toEqual(["user", "assistant", "assistant"]);
		expect(container.textContent).toContain("The quick brown fox");
	});

	it("keeps an orphan tool result visible on its own", () => {
		const { container } = render(Transcript, { props: { messages: orphanResult } });
		expect(roles(container)).toEqual(["tool-result", "assistant"]);
	});

	it("marks only the tail message as streaming", async () => {
		const { container } = render(Transcript, {
			props: { messages: streamingTurn, isStreaming: true },
		});
		await tick();
		expect(container.querySelector(".transcript")?.getAttribute("aria-busy")).toBe("true");
		expect(container.querySelector("details.tool")?.getAttribute("data-state")).toBe("running");
	});

	it("shows a placeholder for an assistant turn with nothing in it yet", () => {
		const messages: AgentMessage[] = [user("go"), assistant([], "pending")];
		const { container } = render(Transcript, { props: { messages, isStreaming: true } });
		expect(container.querySelector(".cursor")).not.toBeNull();
	});

	it("says something sensible when there is nothing to show", () => {
		const { container } = render(Transcript, { props: { messages: [] } });
		expect(container.querySelector(".empty")).not.toBeNull();

		const busy = render(Transcript, { props: { messages: [], isStreaming: true } });
		expect(busy.container.querySelector(".waiting")).not.toBeNull();
	});

	it("keeps the DOM it already has when the tail message is upserted (D3)", async () => {
		// The server replaces the tail `AgentMessage` object on every token.
		// Role and timestamp are stable across that (verified against
		// resources/fixtures/pi/text.jsonl: message_start and message_end carry
		// the same timestamp), so the key is stable and Svelte updates in place
		// rather than rebuilding -- which is what keeps disclosure state, scroll
		// position and the markdown throttle alive mid-turn.
		const first = user("go");
		const tail = assistant([{ type: "text", text: "par" }], "pending");
		const { container, rerender } = render(Transcript, {
			props: { messages: [first, tail], isStreaming: true },
		});
		const before = [...container.querySelectorAll("article")];

		const grown = { ...tail, content: [{ type: "text" as const, text: "partial answer" }] };
		await rerender({ messages: [first, grown], isStreaming: true });
		await tick();

		const after = [...container.querySelectorAll("article")];
		expect(after).toHaveLength(before.length);
		expect(after[0]).toBe(before[0]);
		expect(after[1]).toBe(before[1]);
	});

	it("rebuilds when a different message takes the slot", async () => {
		const { container, rerender } = render(Transcript, { props: { messages: [user("one")] } });
		const before = container.querySelector("article");
		await rerender({ messages: [assistant([{ type: "text", text: "other" }])] });
		await tick();
		expect(container.querySelector("article")).not.toBe(before);
	});

	it("renders the whole sample gallery without throwing", () => {
		const { container } = render(Transcript, { props: { messages: everything } });
		expect(container.querySelectorAll("article").length).toBe(
			everything.filter((m) => m.role !== "toolResult").length,
		);
		expect([...container.querySelectorAll("details.tool")].map((d) => d.getAttribute("data-tool"))).toEqual([
			"read",
			"edit",
			"read",
			"weather__forecast",
			"bash",
		]);
	});

	it("shows both error shapes in one transcript", () => {
		const { container } = render(Transcript, { props: { messages: errors } });
		expect(container.querySelector("details.tool[data-state='error']")).not.toBeNull();
		expect(container.querySelector(".banner.error")).not.toBeNull();
	});
});
