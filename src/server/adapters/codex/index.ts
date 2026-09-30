/**
 * The Codex backend adapter (DESIGN "Codex `ThreadItem` -> `AgentMessage`").
 *
 * - `mapping.ts`  pure item -> message translation
 * - `reducer.ts`  the streaming assembly state machine over the event stream
 * - `jsonrpc.ts`  request/response correlation
 * - `process.ts`  the sbox spawn seam
 * - `adapter.ts`  `BackendAdapter` itself
 */

export { CodexAdapter, CodexAdapterFactory, type CodexAdapterOptions } from "./adapter.ts";
export { CodexReducer, type CodexEffect, type CodexReducerOptions } from "./reducer.ts";
export { CODEX_TOOL_NAMES, mapItem, usageFromBreakdown, type MappedItem } from "./mapping.ts";
export { codexCommand, spawnCodex, type CodexProcess, type CodexSpawner } from "./process.ts";
export { CodexClient, CodexRpcError } from "./jsonrpc.ts";
