/**
 * The turn-done badge's decision (OW-diyuwu).
 *
 * This carries the focus half of the feature on its own, because no browser
 * available here can supply the input it turns on. Playwright drives
 * `chromium-headless-shell`, which reports `document.hasFocus() === true` for
 * every page unconditionally; the levers probed on 2026-08-18 -- a second page
 * in the same context brought to the front, `window.blur()`, and CDP
 * `Emulation.setFocusEmulationEnabled(false)` -- moved neither `hasFocus` nor
 * `visibilityState`, and the full `chromium` build, which does model focus,
 * does not launch on this machine. `e2e/badge.spec.ts` covers the rest of the
 * chain in a real browser with `document.hasFocus` stubbed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	emptyTurnWatch,
	setFaviconBadge,
	watchFocus,
	watchRename,
	watchSessions,
	watchSubmit,
	type TurnWatch,
} from "./favicon.ts";

const UNFOCUSED = false;
const FOCUSED = true;

/** `isStreaming` for one session, in the shape `watchSessions` reads. */
function streaming(key: string, isStreaming: boolean): Map<string, boolean> {
	return new Map([[key, isStreaming]]);
}

/**
 * The event order a live Pi turn produces, from OW-27's close note: the echoed
 * user message and the assistant placeholder both land while the session still
 * reads `isStreaming:false`, and only then does `status:true` follow.
 */
function runTurn(watch: TurnWatch, key: string, hasFocus: boolean): TurnWatch {
	let next = watch;
	next = watchSessions(next, streaming(key, false), hasFocus); // echoed user message
	next = watchSessions(next, streaming(key, false), hasFocus); // assistant placeholder
	next = watchSessions(next, streaming(key, true), hasFocus); // status:true
	next = watchSessions(next, streaming(key, true), hasFocus); // a chunk
	next = watchSessions(next, streaming(key, false), hasFocus); // status:false
	return next;
}

describe("the turn-done watch", () => {
	it("badges a turn this tab submitted that finishes unfocused", () => {
		const watch = runTurn(watchSubmit(emptyTurnWatch(), "pi:a"), "pi:a", UNFOCUSED);
		expect(watch.badged).toBe(true);
	});

	it("does nothing at all when the turn finishes with the window focused", () => {
		const watch = runTurn(watchSubmit(emptyTurnWatch(), "pi:a"), "pi:a", FOCUSED);
		expect(watch.badged).toBe(false);
	});

	it("does not badge on the `isStreaming:false` that still stands just after a submit", () => {
		// The trap: done is a transition, not a level. Arm on the level and the
		// badge fires the instant you press Send.
		let watch = watchSubmit(emptyTurnWatch(), "pi:a");
		watch = watchSessions(watch, streaming("pi:a", false), UNFOCUSED);
		watch = watchSessions(watch, streaming("pi:a", false), UNFOCUSED);
		expect(watch.badged).toBe(false);
		// And it is still armed, so the real end of the turn does badge.
		watch = watchSessions(watch, streaming("pi:a", true), UNFOCUSED);
		watch = watchSessions(watch, streaming("pi:a", false), UNFOCUSED);
		expect(watch.badged).toBe(true);
	});

	it("ignores a session this tab never submitted to", () => {
		// It was mid-turn when this tab attached, or another browser prompted it.
		let watch = emptyTurnWatch();
		watch = watchSessions(watch, streaming("pi:a", true), UNFOCUSED);
		watch = watchSessions(watch, streaming("pi:a", false), UNFOCUSED);
		expect(watch.badged).toBe(false);
	});

	it("stops watching a session once its turn has ended", () => {
		let watch = runTurn(watchSubmit(emptyTurnWatch(), "pi:a"), "pi:a", FOCUSED);
		expect(watch.waiting.size).toBe(0);
		// A second turn, started from somewhere else, is not this tab's business.
		watch = watchSessions(watch, streaming("pi:a", true), UNFOCUSED);
		watch = watchSessions(watch, streaming("pi:a", false), UNFOCUSED);
		expect(watch.badged).toBe(false);
	});

	it("follows a session renamed mid-turn (D9)", () => {
		let watch = watchSubmit(emptyTurnWatch(), "pi:draft");
		watch = watchSessions(watch, streaming("pi:draft", true), UNFOCUSED);
		watch = watchRename(watch, "pi:draft", "pi:named");
		expect([...watch.waiting.keys()]).toEqual(["pi:named"]);
		// The rename carries the "has streamed" bit with it, so the turn's own
		// status:false under the new key still reads as done.
		watch = watchSessions(watch, streaming("pi:named", false), UNFOCUSED);
		expect(watch.badged).toBe(true);
	});

	it("leaves a rename of a session it is not watching alone", () => {
		const watch = watchSubmit(emptyTurnWatch(), "pi:a");
		expect(watchRename(watch, "pi:b", "pi:c")).toBe(watch);
	});

	it("keeps waiting while the client has no view of the session yet", () => {
		// The submit's POST can resolve before the first SSE event arrives (D2).
		let watch = watchSubmit(emptyTurnWatch(), "pi:a");
		watch = watchSessions(watch, new Map(), UNFOCUSED);
		expect(watch.waiting.get("pi:a")).toBe(false);
	});

	it("clears on focus, and stays clear", () => {
		let watch = runTurn(watchSubmit(emptyTurnWatch(), "pi:a"), "pi:a", UNFOCUSED);
		watch = watchFocus(watch);
		expect(watch.badged).toBe(false);
		watch = watchSessions(watch, streaming("pi:a", false), FOCUSED);
		expect(watch.badged).toBe(false);
	});

	it("badges once for two sessions and clears both with one focus", () => {
		let watch = watchSubmit(watchSubmit(emptyTurnWatch(), "pi:a"), "pi:b");
		watch = runTurn(watch, "pi:a", UNFOCUSED);
		watch = runTurn(watch, "pi:b", UNFOCUSED);
		expect(watch.badged).toBe(true);
		expect(watch.waiting.size).toBe(0);
		expect(watchFocus(watch).badged).toBe(false);
	});
});

describe("the icon element", () => {
	beforeEach(() => {
		document.head.innerHTML = "";
	});

	it("creates the link on a page that declares none, so both pages use this code", () => {
		setFaviconBadge(false);
		const links = document.querySelectorAll('link[rel="icon"]');
		expect(links.length).toBe(1);
		expect(links[0]!.getAttribute("type")).toBe("image/svg+xml");
	});

	it("swaps the href of the link the page already declares, and swaps it back", () => {
		document.head.innerHTML = '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />';
		const link = document.querySelector('link[rel="icon"]')!;
		const plain = link.getAttribute("href");

		setFaviconBadge(true);
		expect(document.querySelectorAll('link[rel="icon"]').length).toBe(1);
		expect(link.getAttribute("href")).not.toBe(plain);

		setFaviconBadge(false);
		expect(link.getAttribute("href")).toBe(plain);
	});
});
