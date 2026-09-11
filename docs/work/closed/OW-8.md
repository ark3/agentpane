---
labels: [deferral]
closed: done
---

# The `thread/resume` response is asserted as `ThreadStartResponse` rather than the generated `ThreadResumeResponse`.

Codex adapter

## Close note

The `thread/resume` call in `start()` (`src/server/adapters/codex/adapter.ts`) now asserts `ThreadResumeResponse`; `thread/start` still asserts `ThreadStartResponse`. `src/server/adapters/codex/protocol.ts` gained the re-export, placed beside the `ThreadResumeParams` line it pairs with.

No runtime consequence, and that was checked rather than assumed: `diff` of the two generated files reports exactly one differing line, the type name in the alias. They are field-for-field identical today, so this change fixes nothing that can bite now. What it buys is that the call site names the type the protocol defines for that method, so the compiler is what notices if they ever diverge.

There is no red-then-green here and none was manufactured — a pure type annotation has no behaviour, and a test asserting what the compiler already asserts is a second copy that can rot. The verification is the negative one, and it was run twice, once by the implementer and once independently: asserting a plainly wrong type at that call site (`ThreadReadResponse`) makes `bunx tsc --noEmit` exit 2 with four `TS2339` errors naming `model`, `modelProvider` and `reasoningEffort` at the downstream reads. So the typecheck does cover this expression and would catch a wrong type here. `bun run check` passes clean with the real change, 1014 tests.

The two-line comment below the call — "`ThreadResumeResponse` carries `reasoningEffort` identically, so this one line covers both branches above" — was removed. It existed *because* the resume branch was mistyped: a human had verified by hand what nothing checked, since the compiler only ever saw `ThreadStartResponse`. `started` is now a genuine union of the two response types, so a property access on it compiles only if both members carry that property, which is exactly what the comment asserted. The negative check above is the evidence that the compiler enforces it.

Nothing else changed. No other `thread/resume` call site exists, and no other response type in the adapter is asserted as a sibling's.

Landed on `main` as d906088.
