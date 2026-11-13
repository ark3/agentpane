/**
 * `createApp` as the existing tests want it: with a known token, sent on every
 * request that does not already carry an `Authorization` header of its own.
 * A test of the token itself builds its app with `createApp` and `TEST_API_TOKEN`
 * directly, so that nothing is added behind its back.
 */

import { type App, createApp } from "../app.ts";
import type { AppDeps } from "../deps.ts";

export const TEST_API_TOKEN = "test-api-token-0123456789abcdef";

export function createTestApp(deps: Omit<AppDeps, "apiToken">): App {
	const app = createApp({ ...deps, apiToken: TEST_API_TOKEN });
	return {
		...app,
		fetch(request: Request): Promise<Response> {
			if (!request.headers.has("authorization")) {
				request.headers.set("authorization", `Bearer ${TEST_API_TOKEN}`);
			}
			return app.fetch(request);
		},
	};
}
