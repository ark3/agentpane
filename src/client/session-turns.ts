/**
 * Per-row turn completion state.
 *
 * Unlike the favicon watch, this observes every live session, whether or not
 * this tab submitted its turn. The state is pure so the transition and rename
 * rules do not depend on Svelte scheduling.
 */
export interface SessionTurnMarks {
	/** The last live `isStreaming` level observed for each session. */
	readonly streaming: ReadonlyMap<string, boolean>;
	/** Sessions whose most recently observed turn ended while another was selected. */
	readonly finished: ReadonlySet<string>;
}

export function emptySessionTurnMarks(): SessionTurnMarks {
	return { streaming: new Map(), finished: new Set() };
}

/**
 * Fold one publish of the live session map into the row markers.
 *
 * A false level is completion only after true has been observed. This mirrors
 * the guard used by follow mode and the favicon: immediately after a submit,
 * the echoed message can arrive before the separate `status:true` event.
 */
export function foldSessionTurns(
	marks: SessionTurnMarks,
	streaming: ReadonlyMap<string, boolean>,
	selectedKey: string | null,
): SessionTurnMarks {
	let observed: Map<string, boolean> | undefined;
	let finished: Set<string> | undefined;

	for (const [key, isStreaming] of streaming) {
		const previous = marks.streaming.get(key);
		if (previous !== isStreaming) {
			observed ??= new Map(marks.streaming);
			observed.set(key, isStreaming);
		}
		if (previous === true && !isStreaming && key !== selectedKey && !marks.finished.has(key)) {
			finished ??= new Set(marks.finished);
			finished.add(key);
		}
	}

	if (selectedKey !== null && (finished ?? marks.finished).has(selectedKey)) {
		finished ??= new Set(marks.finished);
		finished.delete(selectedKey);
	}

	if (observed === undefined && finished === undefined) return marks;
	return { streaming: observed ?? marks.streaming, finished: finished ?? marks.finished };
}

/** Carry both the transition guard and any retained mark across a D9 rename. */
export function renameSessionTurnMarks(
	marks: SessionTurnMarks,
	from: string,
	to: string,
): SessionTurnMarks {
	if (from === to) return marks;
	const hasStreaming = marks.streaming.has(from);
	const hasFinished = marks.finished.has(from);
	if (!hasStreaming && !hasFinished) return marks;

	let streaming: Map<string, boolean> | undefined;
	if (hasStreaming) {
		streaming = new Map(marks.streaming);
		streaming.delete(from);
		streaming.set(to, marks.streaming.get(from)!);
	}

	let finished: Set<string> | undefined;
	if (hasFinished) {
		finished = new Set(marks.finished);
		finished.delete(from);
		finished.add(to);
	}
	return { streaming: streaming ?? marks.streaming, finished: finished ?? marks.finished };
}
