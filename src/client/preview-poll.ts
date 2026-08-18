/**
 * The adaptive schedule behind a read-only preview's self-refresh (OW-76).
 *
 * Pure arithmetic, in its own module, so the ceiling and the doubling are
 * asserted without a timer race: the controller owns the one `setTimeout` that
 * consumes this, and only that timer needs faking. Chained timeout rather than
 * `setInterval` because the delay changes on every tick and a chained timeout
 * cannot overlap a slow fetch.
 */

/** The rate a preview polls at once it has just seen the file grow. */
export const PREVIEW_POLL_FAST_MS = 1_000;
/** Both the starting delay and the ceiling backoff climbs back to. */
export const PREVIEW_POLL_IDLE_MS = 16_000;

/**
 * The delay for the next poll, given the one that just elapsed and whether the
 * refresh it fired found new turns.
 *
 * A change snaps straight to the floor -- a session that just grew is likely
 * mid-turn. Quiet doubles, capped: 1, 2, 4, 8, 16, then flat.
 *
 * Only a *timer* tick may pass `changed: false` here. A manual Refresh or a
 * focus refresh that finds nothing must leave the delay alone: backoff measures
 * how quiet the transcript file is, and a user gesture is not evidence about
 * that (decided 2026-08-18, OW-76).
 */
export function nextPreviewDelay(current: number, changed: boolean): number {
	if (changed) return PREVIEW_POLL_FAST_MS;
	return Math.min(current * 2, PREVIEW_POLL_IDLE_MS);
}
