/**
 * The bodies of the socket's queries and commands that need more than one
 * call into the session manager, each taking its parameters as parsed values
 * and refusing with `Refusal`; `socket.ts` reads them off the frame. The
 * commands on a live session are not here, since each is one call on the
 * session its handle names (D31 point 9).
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
	type BackendId,
	type CreateSessionResponse,
	type ModelsResponse,
	type SessionPreviewResponse,
	type SessionRef,
	sessionKey,
} from "../../shared/protocol.ts";
import type { BackendAdapter } from "../adapters/types.ts";
import type { AppDeps } from "./deps.ts";
import { describe, Refusal } from "./failure.ts";
import type { SessionManager } from "./session-manager.ts";

const BACKENDS: readonly BackendId[] = ["pi", "codex", "claude"];

export function isBackendId(value: unknown): value is BackendId {
	return value === "pi" || value === "codex" || value === "claude";
}

/**
 * One rule for all three backends, Pi's: as of `pi 1.0.0` it trims a name,
 * refuses one empty after that, and stores line breaks as one space
 * (`set_session_name` in `rpc-mode.js`, `appendSessionInfo`).
 */
export function sessionName(raw: unknown): string {
	const name = typeof raw === "string" ? raw.replace(/[\r\n]+/g, " ").trim() : "";
	if (name === "") throw new Refusal("bad_request", "name is required and must not be blank");
	return name;
}

export async function editDraft(text: string): Promise<string> {
	const editor = process.env.EDITOR;
	if (!editor) throw new Refusal("editor_failed", "$EDITOR is not set");

	const directory = await mkdtemp(join(tmpdir(), "agentpane-draft-"));
	// Markdown gave multiline prompts useful editor mode in practice; there is no format setting to maintain.
	const filename = join(directory, "draft.md");
	try {
		await writeFile(filename, text, "utf8");
		// Deliberately outside D7's agent sandbox: this is the trusted operator's own editor.
		// The one read above, handed down, since `sh` would read the variable
		// again after the awaits.
		const exitCode = await new Promise<number>((resolve, reject) => {
			const child = spawn("sh", ["-c", 'exec $EDITOR "$1"', "agentpane-edit-draft", filename], {
				stdio: "inherit",
				env: { ...process.env, EDITOR: editor },
			});
			child.once("error", reject);
			child.once("close", (code) => resolve(code ?? 1));
		});
		if (exitCode !== 0) {
			throw new Refusal("editor_failed", `external editor exited with status ${exitCode}`);
		}
		return await readFile(filename, "utf8");
	} catch (err: unknown) {
		if (err instanceof Refusal) throw err;
		throw new Refusal("editor_failed", describe(err));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function createSession(
	sessions: SessionManager,
	cwd: unknown,
	backend: unknown,
	model: string | undefined,
): Promise<CreateSessionResponse> {
	if (typeof cwd !== "string" || !isAbsolute(cwd)) {
		throw new Refusal("bad_request", "cwd is required and must be an absolute path");
	}
	let isDirectory = false;
	try {
		isDirectory = (await stat(cwd)).isDirectory();
	} catch {
		// Not there is not a directory either.
	}
	if (!isDirectory) throw new Refusal("bad_request", "cwd must name an existing directory");
	if (!isBackendId(backend)) throw new Refusal("bad_backend", `unknown backend "${String(backend)}"`);
	// Starts the agent too, and a start that fails leaves nothing (D30). The
	// summary is the container's, under whatever ref the start gave it.
	return { session: await sessions.create(cwd, backend, model) };
}

/**
 * Read-only, non-attaching (OW-38): selecting a session to look at must not
 * spawn one, and must not re-walk the corpus (D9). It reads the one stored
 * file for this ref through the index seam and returns its mapped transcript
 * messages. It asks `sessions` one thing, whether it holds the ref, so that no
 * file reads as `gone` only for a session nobody holds (D26 point 5); a held
 * one with nothing on disk yet is empty. Asked before the read: asked after, a
 * file that appeared during it for a session closed meanwhile would read as
 * gone.
 */
export async function previewSession(
	deps: AppDeps,
	sessions: SessionManager,
	ref: SessionRef,
): Promise<SessionPreviewResponse> {
	const held = sessions.holds(ref);
	const turns = await deps.index.preview(ref);
	if (turns === null && !held) throw new Refusal("gone", `no such session: ${sessionKey(ref)}`);
	return { ref, turns: turns ?? [] };
}

export async function listModels(
	deps: AppDeps,
	sessions: SessionManager,
	backend: string | null,
): Promise<ModelsResponse> {
	if (backend !== null && !isBackendId(backend)) {
		throw new Refusal("bad_backend", `unknown backend "${backend}"`);
	}
	const wanted = backend ? [backend] : BACKENDS;
	const models: ModelsResponse["models"] = [];
	for (const id of wanted) {
		const factory = deps.adapters[id];
		if (!factory) continue;
		// Prefer a live adapter -- a running agent can answer authoritatively.
		// Otherwise ask an unstarted one: model lists are a property of the
		// backend, not of a session, but `listModels` only exists on an adapter
		// instance. Construction is contractually side-effect-free, so this
		// spawns nothing.
		//
		// Known limitation, verified against the real `PiAdapter`: asking one
		// that has not been started rejects with "Pi process is not running".
		// A filtered request surfaces that failure to its caller; the merged
		// request still omits Pi so another backend's useful answer survives.
		// Spawning to answer a *listing* question is exactly what D9 rules out.
		const live = sessions
			.liveRefs()
			.filter((ref) => ref.backend === id)
			.map((ref) => sessions.adapterFor(ref))
			.find((adapter) => adapter !== undefined);
		let adapter: BackendAdapter;
		try {
			adapter = live ?? factory.create({ backend: id, id: "" });
		} catch (cause) {
			// A factory that will not construct without a real id is still not
			// grounds for failing the other backend's list.
			if (backend !== null) throw cause;
			continue;
		}
		try {
			models.push(...(await adapter.listModels()));
		} catch (cause) {
			// Ditto for a backend that cannot enumerate without a subprocess.
			if (backend !== null) throw cause;
		} finally {
			if (!live) await Promise.resolve(adapter.dispose()).catch(() => {});
		}
	}
	return { models };
}
