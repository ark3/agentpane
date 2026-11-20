/**
 * The browser's copy of the API token, and whether it is being asked for.
 *
 * The server never serves the token, in a page or from a route: whatever it
 * served without authentication, a sandboxed agent could fetch as well. So
 * the owner pastes it once per origin and it is kept in that origin's
 * `localStorage`, which a page on another origin, a DNS-rebinding one among
 * them, cannot read.
 *
 * The storage is injected, as `main.ts` injects the visibility predicate into
 * the controller, so this module stays free of `window`.
 */

export const TOKEN_STORAGE_KEY = "agentpane-token";

export interface TokenGate {
	/** The stored token, or null before the first paste. */
	token(): string | null;
	/** The server refused the token the socket's `hello` carried: ask for it, again if a stored one was rotated. */
	unauthorized(): void;
	/** The server accepted the token a `hello` carried, this tab's paste or one another tab stored: stop asking. */
	authorized(): void;
	/** Keep a pasted token and stop asking. */
	store(token: string): void;
	asking(): boolean;
	subscribe(listener: () => void): () => void;
}

export function createTokenGate(storage: Pick<Storage, "getItem" | "setItem">): TokenGate {
	let asking = false;
	const listeners = new Set<() => void>();

	function setAsking(next: boolean): void {
		if (asking === next) return;
		asking = next;
		for (const listener of listeners) listener();
	}

	return {
		token: () => storage.getItem(TOKEN_STORAGE_KEY),
		unauthorized: () => setAsking(true),
		authorized: () => setAsking(false),
		store(token) {
			storage.setItem(TOKEN_STORAGE_KEY, token);
			setAsking(false);
		},
		asking: () => asking,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
