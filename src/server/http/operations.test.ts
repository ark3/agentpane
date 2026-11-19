import { describe, expect, it } from "vitest";
import { editDraft } from "./operations.ts";

describe("editDraft", () => {
	it("spawns the editor named at the call, whatever the variable says by the spawn", async () => {
		const priorEditor = process.env.EDITOR;
		process.env.EDITOR = `sh ${new URL("./testing/editor-fixture.sh", import.meta.url).pathname} --replace`;
		try {
			const pending = editDraft("original draft");
			// Read, and the awaits before the spawn not yet over: a test putting
			// back the real editor here launched it.
			process.env.EDITOR = "false";
			expect(await pending).toBe("edited by fixture");
		} finally {
			if (priorEditor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = priorEditor;
		}
	});
});
