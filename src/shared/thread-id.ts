/**
 * The short form a Codex child thread goes by wherever there is no room for
 * its whole id: the subagent card's header (`toolSummary`) and the prefix
 * each child's reply carries in the collab result body (`mapItem`). One
 * definition, so header and body name a child the same way (OW-guyunu).
 *
 * The *last* eight characters, not the first. Codex thread ids are UUIDv7,
 * whose leading characters are a millisecond timestamp, so children spawned
 * in the same second share them -- collab-multi's two-child `wait` read
 * `wait · 01a0f517 · 01a0f517` when this took the head. The tail is random.
 */
export function shortThreadId(id: string): string {
	return id.slice(-8);
}
