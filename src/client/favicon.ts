/**
 * The turn-done favicon badge (OW-diyuwu).
 *
 * A turn that finishes while the tab is in the background goes unnoticed until
 * you happen to look at it. This badges the icon when a turn *this tab
 * submitted* ends while the window is unfocused, and clears it the moment the
 * window is focused again.
 *
 * Split deliberately: everything above `setFaviconBadge` is pure and holds the
 * whole decision, so `favicon.test.ts` can drive the two orderings that
 * actually bite without a browser. `setFaviconBadge` is the only part that
 * touches the DOM, and it is one attribute.
 *
 * Unfocused means `document.hasFocus()`, not `document.visibilityState`. The
 * two disagree in one case -- agentpane visible on a second monitor while you
 * type in an editor -- and that case badges. A dot you did not need costs a
 * glance; one that never appears costs the feature.
 */

/**
 * The sessions this tab is waiting on, and whether a finished turn is still
 * unseen. Keys are `sessionKey(ref)`, like everything else in the client state.
 */
export interface TurnWatch {
	/** Session key -> whether `isStreaming` has read true since that session's submit. */
	readonly waiting: ReadonlyMap<string, boolean>;
	readonly badged: boolean;
}

export function emptyTurnWatch(): TurnWatch {
	return { waiting: new Map(), badged: false };
}

/**
 * A submit from this tab. Only sessions that pass through here can ever badge:
 * a session can stream for other reasons -- it was mid-turn when you attached,
 * or another browser prompted it -- and none of those are yours to be told
 * about.
 */
export function watchSubmit(watch: TurnWatch, key: string): TurnWatch {
	const waiting = new Map(watch.waiting);
	waiting.set(key, false);
	return { ...watch, waiting };
}

/**
 * Carry a watched session across its rename (D9: every new session gets one, on
 * its first prompt). Without this the set is orphaned under the old key and the
 * badge misses the one turn it was armed for.
 */
export function watchRename(watch: TurnWatch, from: string, to: string): TurnWatch {
	const sawStreaming = watch.waiting.get(from);
	if (sawStreaming === undefined) return watch;
	const waiting = new Map(watch.waiting);
	waiting.delete(from);
	waiting.set(to, sawStreaming);
	return { ...watch, waiting };
}

/** The window is focused: whatever was waiting to be noticed has been noticed. */
export function watchFocus(watch: TurnWatch): TurnWatch {
	return watch.badged ? { ...watch, badged: false } : watch;
}

/**
 * Fold one publish of the client state in. `streaming` is `isStreaming` for
 * every session the client knows about; `hasFocus` is `document.hasFocus()`
 * read at that moment.
 *
 * Done is a *transition*, not a level. After a submit the session still reads
 * `isStreaming:false` for a beat: the echoed user message and the assistant's
 * placeholder both land before `status:true` does, which is the ordering a live
 * Pi turn was observed to produce (OW-27's close note, and the `runTurn`
 * docblock in `e2e/harness.ts` that reproduces it). So a session badges only on
 * a false that follows a true -- arm on the level instead and the badge fires
 * the instant you press Send. `App.svelte`'s follow mode carries the same guard
 * as `hasStreamed`, for the same reason.
 *
 * An aborted or errored turn counts as done: both arrive as the same
 * `status:false`, and you asked for something and it stopped. First cut,
 * 2026-08-18 -- revisit from use if a dot for a turn you cancelled yourself
 * reads as noise.
 */
export function watchSessions(
	watch: TurnWatch,
	streaming: ReadonlyMap<string, boolean>,
	hasFocus: boolean,
): TurnWatch {
	let waiting: Map<string, boolean> | undefined;
	let badged = watch.badged;
	for (const [key, sawStreaming] of watch.waiting) {
		const isStreaming = streaming.get(key);
		// A session the client has no view of yet: the submit's own POST can
		// resolve before the first SSE event for it arrives (D2). Keep waiting.
		if (isStreaming === undefined) continue;
		if (isStreaming === sawStreaming) continue;
		waiting ??= new Map(watch.waiting);
		if (isStreaming) {
			waiting.set(key, true);
		} else {
			// The turn ended. Stop watching, so a later stream this tab did not
			// ask for cannot badge.
			waiting.delete(key);
			if (!hasFocus) badged = true;
		}
	}
	if (waiting === undefined && badged === watch.badged) return watch;
	return { waiting: waiting ?? watch.waiting, badged };
}

/** The icon `index.html` links, and its badged sibling. Both live in `public/`. */
const PLAIN_ICON = "/favicon.svg";
const BADGED_ICON = "/favicon-badged.svg";

/**
 * Point the page's icon at one of the two served files.
 *
 * Two static files swapped by `href` rather than a data-URI SVG or a
 * canvas-rendered PNG built at runtime: this is the well-supported path and
 * needs no probe.
 *
 * Creates the `<link rel="icon">` when the page declares none, which is how
 * `e2e/harness.html` -- which declares no icon -- reaches the icon through
 * exactly the code `index.html` does. A browser test against a second
 * mechanism would prove nothing about the app.
 */
export function setFaviconBadge(badged: boolean): void {
	const href = badged ? BADGED_ICON : PLAIN_ICON;
	let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		link.type = "image/svg+xml";
		document.head.append(link);
	}
	// This runs on every state publish; only a change should touch the DOM.
	if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}
