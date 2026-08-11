# Minimal Live Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable agentpane workflow and prove it with a live Codex turn while keeping Pi verification offline.

**Architecture:** A typed client API owns REST and EventSource I/O, a pure reducer owns server-authoritative session state, and a small controller connects both to a minimal Svelte shell. The production server receives a filesystem-backed `SessionIndex`, the verified Pi factory, and—after recovery and review—the Codex factory.

**Tech Stack:** Bun, TypeScript 5.9, Svelte 5, Vite 7, Vitest 3, Testing Library, existing `AgentMessage` and shared protocol types.

## Global Constraints

- Live model/agent testing in this environment is Codex-only.
- Pi remains enabled but is verified through its existing fixtures, unit tests, process tests, and contract tests.
- Do not claim the deferred manual Pi checks passed.
- Keep `src/shared/protocol.ts` authoritative; do not duplicate route strings or wire types.
- Keep Pi package imports type-only.
- Use generated types under `resources/codex-protocol/` as the Codex protocol authority.
- Assert on event and message structure, never live model wording.
- Every defect test must be observed failing against the unfixed implementation before the fix is accepted.
- `bun run check` must pass at every task boundary.

---

## File map

### Create

- `src/client/api.ts` — typed REST operations, SSE connection, and error decoding.
- `src/client/api.test.ts` — client transport tests with injected fetch/EventSource seams.
- `src/client/session-state.ts` — pure event reducer and sequence-gap decisions.
- `src/client/session-state.test.ts` — exhaustive reducer tests.
- `src/client/controller.ts` — orchestration for list/create/attach/prompt/abort/reconnect.
- `src/client/controller.test.ts` — orchestration tests using a fake client API.
- `src/client/app.css` — app layout and shared tokens imported once.
- `src/server/composition.ts` — production `SessionIndex` and adapter registry construction.
- `src/server/composition.test.ts` — composition tests that do not spawn agents.
- `src/server/adapters/codex/*` — recovered files from `wip/codex-adapter`, reviewed incrementally.
- `docs/MANUAL_TESTING.md` — live Codex evidence and deferred Pi checklist.

### Modify

- `src/client/App.svelte` — replace scaffold with minimal shell.
- `src/client/App.test.ts` — shell interaction and state tests.
- `src/client/main.ts` — import global app CSS and construct the production controller.
- `src/client/render/Transcript.svelte` — move root tokens only if required by the shell.
- `src/server/index.ts` — consume production composition.
- `docs/WORKSTREAMS.md` — record verified completion and remaining manual Pi work.
- `README.md` — remove the stale “No source exists yet” statement and add run instructions.

---

### Task 1: Pure client session reducer

**Files:**
- Create: `src/client/session-state.ts`
- Create: `src/client/session-state.test.ts`

**Interfaces:**
- Consumes: `ServerEvent`, `SessionRef`, `SessionSummary`, `AgentRequest`, and `sessionKey` from `$shared/protocol.ts`; `AgentMessage` as a type-only import.
- Produces: `ClientState`, `SessionView`, `initialClientState()`, and `reduceServerEvent(state, event): ReduceResult`.

- [ ] **Step 1: Write failing state tests**

Cover these exact cases in `session-state.test.ts`:

```ts
it("replaces a transcript and resets sequence on snapshot", () => {
	const result = reduceServerEvent(stateWithSelected(ref), {
		type: "snapshot", session: ref, seq: 7, messages: [userMessage("hi")], isStreaming: true,
	});
	expect(result.state.sessions[sessionKey(ref)]).toMatchObject({ seq: 7, isStreaming: true });
	expect(result.recover).toEqual([]);
});

it("requests recovery instead of applying an event after a sequence gap", () => {
	const state = stateAtSequence(ref, 3);
	const result = reduceServerEvent(state, {
		type: "status", session: ref, seq: 5, isStreaming: false,
	});
	expect(result.state).toBe(state);
	expect(result.recover).toEqual([ref]);
});

it("re-keys selected state atomically on renamed", () => {
	const result = reduceServerEvent(stateAtSequence(oldRef, 2), {
		type: "renamed", from: oldRef, session: newRef, seq: 3,
	});
	expect(result.state.selected).toEqual(newRef);
	expect(result.state.sessions[sessionKey(oldRef)]).toBeUndefined();
	expect(result.state.sessions[sessionKey(newRef)]?.seq).toBe(3);
});
```

Also test append and replacement `upsert`, `status`, session-scoped `error`, retained `request`, and `sessions-changed` returning `refreshSessions: true`.

- [ ] **Step 2: Run the reducer tests and verify RED**

Run: `bunx vitest run --project client src/client/session-state.test.ts`

Expected: FAIL because `session-state.ts` does not exist.

- [ ] **Step 3: Implement the minimal immutable reducer**

Use these public shapes:

```ts
export interface SessionView {
	ref: SessionRef;
	messages: AgentMessage[];
	isStreaming: boolean;
	seq: number | null;
	error: string | null;
	requests: AgentRequest[];
}

export interface ClientState {
	summaries: SessionSummary[];
	selected: SessionRef | null;
	sessions: Record<string, SessionView>;
}

export interface ReduceResult {
	state: ClientState;
	recover: SessionRef[];
	refreshSessions: boolean;
}
```

Snapshots are always accepted. For all session events with a sequence, accept
the first event when no sequence exists; otherwise require `seq === previous +
1`. Ignore events for unselected sessions only at render time, not in the
reducer—the multiplexed stream may carry several live sessions.

- [ ] **Step 4: Run focused and full tests**

Run: `bunx vitest run --project client src/client/session-state.test.ts`

Expected: PASS.

Run: `bun run check`

Expected: 0 diagnostics and all tests pass.

- [ ] **Step 5: Commit the reducer**

```bash
git add src/client/session-state.ts src/client/session-state.test.ts
git commit -m "feat: add client session event reducer"
```

---

### Task 2: Typed REST and SSE client

**Files:**
- Create: `src/client/api.ts`
- Create: `src/client/api.test.ts`

**Interfaces:**
- Consumes: all request/response types and `ROUTES` from `$shared/protocol.ts`.
- Produces: `AgentpaneApi`, `ApiClientError`, `EventConnection`, and `createAgentpaneApi(options?)`.

- [ ] **Step 1: Write failing API tests**

Inject both browser globals so tests never open a socket:

```ts
export interface ApiOptions {
	fetch?: typeof globalThis.fetch;
	openEvents?: (url: string, handlers: EventHandlers) => EventConnection;
}

export interface EventHandlers {
	onEvent(event: ServerEvent): void;
	onOpen(): void;
	onDisconnect(): void;
	onMalformed(error: Error): void;
}
```

Test exact method, route, JSON body, and response decoding for:

- `listSessions(cwd?)`
- `createSession({ cwd, backend })`
- `attach(ref)`
- `prompt(ref, { text })`
- `abort(ref)`

Test that a JSON `ApiError` becomes `ApiClientError` with status, code, and
detail; a non-JSON error retains the HTTP status; malformed SSE JSON calls
`onMalformed`; open/error callbacks map to `onOpen`/`onDisconnect`; and
`close()` closes the EventSource.

- [ ] **Step 2: Run API tests and verify RED**

Run: `bunx vitest run --project client src/client/api.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the API surface**

```ts
export interface AgentpaneApi {
	listSessions(cwd?: string): Promise<SessionSummary[]>;
	createSession(body: CreateSessionRequest): Promise<SessionRef>;
	attach(ref: SessionRef): Promise<SessionSummary>;
	prompt(ref: SessionRef, body: PromptRequest): Promise<void>;
	abort(ref: SessionRef): Promise<void>;
	connect(handlers: EventHandlers): EventConnection;
}
```

Use `ROUTES` for every URL. Send `content-type: application/json` only on
requests with bodies. Treat all 2xx statuses as success. Construct the native
`EventSource` inside the default `openEvents` implementation so importing the
module under tests has no side effect.

- [ ] **Step 4: Run focused and full verification**

Run: `bunx vitest run --project client src/client/api.test.ts`

Expected: PASS.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 5: Commit the API boundary**

```bash
git add src/client/api.ts src/client/api.test.ts
git commit -m "feat: add typed browser transport"
```

---

### Task 3: Client controller and recovery behavior

**Files:**
- Create: `src/client/controller.ts`
- Create: `src/client/controller.test.ts`

**Interfaces:**
- Consumes: `AgentpaneApi` from `api.ts` and reducer functions from `session-state.ts`.
- Produces: `AgentpaneController`, `ControllerView`, and `createController(api)`.

- [ ] **Step 1: Write failing orchestration tests**

Use an in-memory fake API and verify:

1. `start()` connects SSE and loads summaries.
2. `create(cwd, backend)` creates, attaches, selects the authoritative response
   ref, and does not submit a prompt.
3. `select(ref)` attaches and selects the authoritative attached ref.
4. `submit(text)` preserves the draft on failure and clears it only after an
   accepted request.
5. `abort()` targets the current authoritative ref.
6. `renamed` updates the selected ref before a following snapshot.
7. One sequence gap calls `attach(ref)` once; repeated events while recovery is
   in flight do not create duplicate attaches.
8. `sessions-changed` coalesces concurrent list refreshes.
9. `dispose()` closes the SSE connection and prevents later fake events from
   mutating state.

- [ ] **Step 2: Run controller tests and verify RED**

Run: `bunx vitest run --project client src/client/controller.test.ts`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement the controller**

Expose subscription rather than Svelte-specific state so the controller stays
unit-testable:

```ts
export interface ControllerView {
	state: ClientState;
	draft: string;
	connection: "connecting" | "connected" | "reconnecting";
	busy: "idle" | "listing" | "attaching" | "submitting" | "aborting";
	error: string | null;
}

export interface AgentpaneController {
	getView(): ControllerView;
	subscribe(listener: (view: ControllerView) => void): () => void;
	start(): Promise<void>;
	dispose(): void;
	setDraft(text: string): void;
	setWorkspace(cwd: string): Promise<void>;
	create(cwd: string, backend: BackendId): Promise<void>;
	select(ref: SessionRef): Promise<void>;
	submit(): Promise<void>;
	abort(): Promise<void>;
}
```

Validate workspace input with `cwd.startsWith("/")`; server-side validation
remains authoritative. Keep recovery and refresh promises keyed/coalesced
inside the controller.

- [ ] **Step 4: Run focused and full verification**

Run: `bunx vitest run --project client src/client/controller.test.ts`

Expected: PASS.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 5: Commit the controller**

```bash
git add src/client/controller.ts src/client/controller.test.ts
git commit -m "feat: orchestrate browser session state"
```

---

### Task 4: Minimal Svelte shell

**Files:**
- Modify: `src/client/App.svelte`
- Modify: `src/client/App.test.ts`
- Modify: `src/client/main.ts`
- Create: `src/client/app.css`
- Optionally modify: `src/client/render/Transcript.svelte` only to relocate its `:global(:root)` token block unchanged.

**Interfaces:**
- Consumes: `AgentpaneController`, `ControllerView`, and the existing `Transcript` component.
- Produces: an `App` component accepting `{ controller: AgentpaneController }`; `main.ts` constructs the browser API/controller.

- [ ] **Step 1: Replace the scaffold test with failing shell tests**

Render `App` with a fake controller. Verify accessible controls and behavior:

```ts
render(App, { props: { controller } });
await user.type(screen.getByLabelText("Workspace"), "/work/project");
await user.selectOptions(screen.getByLabelText("Backend"), "codex");
await user.click(screen.getByRole("button", { name: "New session" }));
expect(controller.created).toEqual([{ cwd: "/work/project", backend: "codex" }]);
```

Also verify session selection, empty transcript state, rendered transcript,
prompt submission by form, draft preservation on failure, disabled empty
submission, Abort visibility only while streaming, reconnecting status, and a
visible unsupported-agent-request warning.

- [ ] **Step 2: Run App tests and verify RED**

Run: `bunx vitest run --project client src/client/App.test.ts`

Expected: FAIL because the scaffold has none of the controls.

- [ ] **Step 3: Implement the shell**

Use Svelte lifecycle hooks to subscribe/start/dispose the injected controller.
Render:

- `<input aria-label="Workspace">`
- `<select aria-label="Backend">` with `pi` and `codex`
- `New session` button
- a session list of buttons labelled from preview, falling back to backend/id
- `Transcript` with the selected `messages` and `isStreaming`
- `<textarea aria-label="Prompt">`
- `Send` and conditional `Abort` buttons
- `role="status"` for connection/busy state and `role="alert"` for errors

Do not add routing or third-party UI dependencies. Move renderer tokens without
changing values only if the shell consumes them globally.

- [ ] **Step 4: Wire the browser entry point**

In `main.ts`, import `./app.css`, construct `createAgentpaneApi()`, construct
`createController(api)`, and mount:

```ts
const controller = createController(createAgentpaneApi());
export default mount(App, { target, props: { controller } });
```

- [ ] **Step 5: Run client and full verification**

Run: `bunx vitest run --project client`

Expected: all client tests pass.

Run: `bun run build && bun run check`

Expected: Vite build succeeds; typecheck and all tests pass.

- [ ] **Step 6: Commit the shell**

```bash
git add src/client/App.svelte src/client/App.test.ts src/client/main.ts src/client/app.css src/client/render/Transcript.svelte
git commit -m "feat: build minimal agent session shell"
```

Omit `Transcript.svelte` from `git add` if token relocation was unnecessary.

---

### Task 5: Production session index and Pi composition

**Files:**
- Create: `src/server/composition.ts`
- Create: `src/server/composition.test.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: `listSessions`, `PiAdapterFactory`, `SessionIndex`, and `AppDeps`.
- Produces: `createSessionIndex(options?)` and `createProductionDeps(options?)`.

- [ ] **Step 1: Write failing composition tests**

Use temporary fixture roots and injected factories; never spawn Pi. Verify:

- `index.list({ cwd })` delegates the filter and returns summaries.
- `index.get(ref)` returns the matching summary or `null`.
- `get` tolerates unknown refs and old Codex headers without `cwd`.
- production adapters include Pi.
- adapter overrides can replace/extend the registry for tests and later Codex wiring.

- [ ] **Step 2: Run composition tests and verify RED**

Run: `bunx vitest run --project server src/server/composition.test.ts`

Expected: FAIL because `composition.ts` does not exist.

- [ ] **Step 3: Implement composition**

```ts
export interface CompositionOptions {
	index?: SessionIndex;
	adapters?: AppDeps["adapters"];
}

export function createSessionIndex(): SessionIndex {
	return {
		list: (query) => listSessions(query),
		async get(ref) {
			const sessions = await listSessions();
			return sessions.find((item) => sessionKey(item.ref) === sessionKey(ref)) ?? null;
		},
	};
}

export function createProductionDeps(options: CompositionOptions = {}): Pick<AppDeps, "index" | "adapters"> {
	return {
		index: options.index ?? createSessionIndex(),
		adapters: options.adapters ?? { pi: new PiAdapterFactory() },
	};
}
```

Keep the initial linear `get` because the measured corpus does not justify a
cache. Avoid exporting filesystem-root test options from production unless the
tests cannot remain hermetic through an injected index.

- [ ] **Step 4: Replace placeholders in `server/index.ts`**

Construct production dependencies once and spread them into `createApp`; keep
heartbeat and static serving unchanged.

- [ ] **Step 5: Verify without starting a live Pi process**

Run: `bunx vitest run --project server src/server/composition.test.ts src/server/http/app.test.ts`

Expected: PASS.

Run: `bun run build && bun run check`

Expected: PASS.

- [ ] **Step 6: Commit server composition**

```bash
git add src/server/composition.ts src/server/composition.test.ts src/server/index.ts
git commit -m "feat: wire production session index and Pi adapter"
```

---

### Task 6: Recover Codex pure protocol, mapping, and reducer

**Files:**
- Recover from `wip/codex-adapter`: `src/server/adapters/codex/protocol.ts`
- Recover from `wip/codex-adapter`: `src/server/adapters/codex/mapping.ts`
- Recover from `wip/codex-adapter`: `src/server/adapters/codex/reducer.ts`
- Recover from `wip/codex-adapter`: `src/server/adapters/codex/reducer.test.ts`
- Recover from `wip/codex-adapter`: `src/server/adapters/codex/test-support.ts`

**Interfaces:**
- Consumes: generated Codex bindings and captured `resources/fixtures/codex/*.jsonl`.
- Produces: `CodexReducer`, `CodexEffect`, `mapItem`, `MappedItem`, and a narrow `CodexServerMessage` union.

- [ ] **Step 1: Recover only the pure files onto current `main`**

Use a non-destructive branch-based extraction or patch; do not merge the whole
WIP commit. Confirm with:

Run: `git diff --name-status -- src/server/adapters/codex`

Expected: only the five files above are present.

- [ ] **Step 2: Run the inherited reducer test and capture the actual RED state**

Run: `bunx vitest run --project server src/server/adapters/codex/reducer.test.ts`

Expected: the documented `TS2345`/fixture-shape issues or equivalent concrete
failures. Record the exact failures in the task notes before editing.

- [ ] **Step 3: Audit protocol types against generated bindings**

For each hand-written alias in `protocol.ts`, locate its generated source under
`resources/codex-protocol/v2/`. Replace invented field names and overly broad
casts with generated imports or derived discriminated unions. Ensure production
files have no `any` and no value imports from Pi packages.

- [ ] **Step 4: Make fixture tests table-driven and structural**

Drive all three captures (`text`, `tool-read`, `tool-edit`) line by line. Assert:

- user message mapping;
- reasoning and agent text assembly by `itemId`;
- command tool call/result correlation;
- file-change tool call/result and edit arguments compatible with renderer
  `edits[]` or flat pair contract;
- authoritative replacement on `item/completed`;
- streaming state on turn boundaries;
- emitted request effect for file-change approval;
- ignored-but-safe handling of ancillary events in the fixture census.

- [ ] **Step 5: Run reducer tests and full check**

Run: `bunx vitest run --project server src/server/adapters/codex/reducer.test.ts`

Expected: PASS.

Run: `bun run check`

Expected: PASS with the pure Codex slice included.

- [ ] **Step 6: Commit the pure Codex slice**

```bash
git add src/server/adapters/codex/protocol.ts src/server/adapters/codex/mapping.ts src/server/adapters/codex/reducer.ts src/server/adapters/codex/reducer.test.ts src/server/adapters/codex/test-support.ts
git commit -m "feat: map Codex events into agent messages"
```

---

### Task 7: Recover and harden Codex JSON-RPC and process lifecycle

**Files:**
- Recover from `wip/codex-adapter`: `src/server/adapters/codex/jsonrpc.ts`
- Create: `src/server/adapters/codex/jsonrpc.test.ts`
- Recover from `wip/codex-adapter`: `src/server/adapters/codex/process.ts`
- Create: `src/server/adapters/codex/process.test.ts`

**Interfaces:**
- Consumes: LF-delimited app-server JSON-RPC messages.
- Produces: `CodexClient`, `CodexRpcError`, `CodexProcess`, `CodexSpawner`, `LineSplitter`, and `spawnCodex`.

- [ ] **Step 1: Recover the two WIP implementation files without the adapter shell**

Confirm only `jsonrpc.ts` and `process.ts` join the already-reviewed pure files.

- [ ] **Step 2: Write JSON-RPC tests and verify relevant failures**

Test request id correlation, notification delivery, server-initiated requests,
error responses, malformed JSON reporting, rejection of all pending calls on
exit, and disposal. Run the focused test before fixing any failure.

- [ ] **Step 3: Write process tests patterned after Pi process coverage**

Test LF-only framing including U+2028/U+2029, partial chunks, trailing lines,
the exact command `direnv exec <cwd> sbox -- codex app-server`, routine stderr
retention without healthy-session errors, `error` followed by `close`, close
without exit, and idempotent kill/dispose.

- [ ] **Step 4: Fix lifecycle semantics**

Do not rely on `exit` alone. Settle process termination once across `error` and
`close`, preserve a bounded stderr tail for death diagnostics, and reject
pending initialization if spawn fails. Match the proven Pi lifecycle behavior
unless Codex has a documented reason to differ.

- [ ] **Step 5: Run focused and full verification**

Run: `bunx vitest run --project server src/server/adapters/codex/jsonrpc.test.ts src/server/adapters/codex/process.test.ts`

Expected: PASS.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 6: Commit the process boundary**

```bash
git add src/server/adapters/codex/jsonrpc.ts src/server/adapters/codex/jsonrpc.test.ts src/server/adapters/codex/process.ts src/server/adapters/codex/process.test.ts
git commit -m "feat: add tested Codex app-server process client"
```

---

### Task 8: Recover Codex adapter contract and register it

**Files:**
- Recover from `wip/codex-adapter`: `src/server/adapters/codex/adapter.ts`
- Recover from `wip/codex-adapter`: `src/server/adapters/codex/index.ts`
- Create: `src/server/adapters/codex/adapter.test.ts`
- Modify: `src/server/composition.ts`
- Modify: `src/server/composition.test.ts`

**Interfaces:**
- Consumes: reviewed reducer, JSON-RPC client, process seam, and `BackendAdapter`.
- Produces: `CodexAdapter`, `CodexAdapterFactory`, and production `codex` registration.

- [ ] **Step 1: Recover adapter and index, then write contract tests before fixes**

Drive the adapter with the WIP fake process. Test:

- initialize followed by `thread/start` for virtual sessions;
- `thread/resume` and transcript hydration for stored sessions;
- adoption of the real thread id during `start()`;
- text/image `turn/start` input mapping;
- abort with the active turn id;
- reducer effects reaching update/request/error subscribers;
- reply correlation including decline behavior;
- model selection applied to subsequent turns;
- disposal rejecting pending RPC and killing once;
- start failure cleanup;
- factory backend validation.

Fork behavior may remain covered but is not a live-shell completion criterion.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `bunx vitest run --project server src/server/adapters/codex/adapter.test.ts`

Expected: at least the lifecycle/typing defects exposed by current `main` and
the new contract tests.

- [ ] **Step 3: Implement only the fixes needed for contract conformance**

Rename the WIP singleton factory export to a class if necessary so composition
matches Pi consistently:

```ts
export class CodexAdapterFactory implements AdapterFactory {
	create(ref: SessionRef): BackendAdapter {
		if (ref.backend !== "codex") throw new Error(/* precise backend error */);
		return new CodexAdapter(ref);
	}
}
```

Keep construction side-effect-free and spawning exclusively in `start()`.

- [ ] **Step 4: Register Codex in production composition**

Set the default registry to:

```ts
{
	pi: new PiAdapterFactory(),
	codex: new CodexAdapterFactory(),
}
```

Update composition tests to assert both factories exist without calling
`create().start()`.

- [ ] **Step 5: Run all verification**

Run: `bunx vitest run --project server src/server/adapters/codex src/server/composition.test.ts`

Expected: PASS.

Run: `bun run build && bun run check`

Expected: PASS.

- [ ] **Step 6: Commit adapter integration**

```bash
git add src/server/adapters/codex src/server/composition.ts src/server/composition.test.ts
git commit -m "feat: integrate Codex backend adapter"
```

---

### Task 9: Offline end-to-end contract test

**Files:**
- Create: `src/server/http/vertical-slice.test.ts`
- Modify only if a demonstrated defect requires it: client/controller/server files from prior tasks.

**Interfaces:**
- Consumes: real `createApp`, fake adapter/index, shared wire protocol, and client reducer/controller seams.
- Produces: one deterministic proof of create → attach → prompt → SSE updates → abort without a model call.

- [ ] **Step 1: Write the end-to-end test**

Use `createApp` with `FakeAdapterFactory`, open `/api/events`, create a virtual
Codex session, attach it, post a prompt, make the fake adapter emit user and
assistant messages plus streaming transitions, and feed decoded SSE events
through `reduceServerEvent`. Assert the final transcript and streaming state.

Add a second assertion path for a materialized id: fake adapter changes its id
on submit, the stream emits `renamed` followed by `snapshot`, and the reducer's
selected ref follows it.

- [ ] **Step 2: Run the test and verify RED for any integration mismatch**

Run: `bunx vitest run --project server src/server/http/vertical-slice.test.ts`

Expected: FAIL only if an actual boundary mismatch remains. If it passes on the
first run, temporarily break one asserted route/event application and observe
RED before restoring it so the test is proven sensitive.

- [ ] **Step 3: Fix demonstrated boundary defects only**

Do not expand scope. Add the smallest correction, rerun the focused test, and
then rerun the prior unit test for the touched module.

- [ ] **Step 4: Run full verification**

Run: `bun run build && bun run check`

Expected: PASS.

- [ ] **Step 5: Commit the offline vertical proof**

```bash
git add src/server/http/vertical-slice.test.ts src/client src/server
git commit -m "test: prove the offline vertical slice"
```

Before committing, use `git diff --name-only` and stage only files actually
required by demonstrated fixes; do not indiscriminately stage unrelated paths.

---

### Task 10: Live Codex smoke verification and durable handoff

**Files:**
- Create: `docs/MANUAL_TESTING.md`
- Modify: `docs/WORKSTREAMS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: assembled production application and the Codex writable-state
workaround documented in `resources/probes/README.md`.
- Produces: reproducible evidence for Codex and an explicit unverified Pi list.

- [ ] **Step 1: Prepare a writable Codex state directory**

Use the existing probe's credential-copy approach rather than modifying the
real read-only `~/.codex`. Do not print credential contents. Start the server
with the temporary `CODEX_HOME`, then start the Vite client or use the built
static client through the Bun server as appropriate.

- [ ] **Step 2: Run the live Codex checklist**

Verify and record timestamps/results for:

1. create a Codex session for `/home/asa0717/src/agentpane`;
2. submit a text-only prompt and observe incremental transcript updates;
3. observe streaming state return to idle;
4. refresh and confirm repaint without a duplicate child process;
5. submit a deliberately long prompt and abort it;
6. stop the server and confirm no child `codex app-server` remains.

Use process inspection scoped to the PIDs launched by this run. Do not kill
unrelated Codex processes.

- [ ] **Step 3: Diagnose failures systematically**

For any unexpected behavior, invoke `superpowers:systematic-debugging`, capture
the failing boundary, add an automated regression test where possible, observe
RED, then fix. Repeat the live step after offline verification returns green.

- [ ] **Step 4: Write durable testing documentation**

`docs/MANUAL_TESTING.md` must contain:

- exact setup commands with credential values omitted;
- the six Codex checks and observed results;
- CLI version and date;
- the four deferred Pi checks from the design;
- explicit wording that Pi was not live-tested in this environment.

Update `WORKSTREAMS.md` only for work actually verified. Update `README.md` to
remove the stale no-source claim and document normal development/build commands.

- [ ] **Step 5: Run final verification from a clean process state**

Run: `bun run build && bun run check`

Expected: build succeeds, 0 type/Svelte diagnostics, all tests pass.

Run: `git status --short`

Expected: only the intended documentation changes are uncommitted.

- [ ] **Step 6: Commit documentation and evidence**

```bash
git add README.md docs/WORKSTREAMS.md docs/MANUAL_TESTING.md
git commit -m "docs: record the first live Codex vertical slice"
```

---

## Final review gate

Before declaring the milestone complete:

1. Invoke `superpowers:requesting-code-review` for the full branch diff.
2. Address findings using `superpowers:receiving-code-review` and rerun focused tests.
3. Invoke `superpowers:verification-before-completion`.
4. Run fresh `bun run build && bun run check` and cite the actual output.
5. Confirm the final report says Codex was live-tested and Pi was not.
