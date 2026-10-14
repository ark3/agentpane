/**
 * The message kinds Pi adds to `AgentMessage`, declaration-merged here because
 * the types-only packages (D10) no longer carry them.
 *
 * As of `pi-agent-core 0.84.1` its own `harness/messages.ts` merged these four
 * into `CustomAgentMessages`; as of 1.2.0 the harness has left that package and
 * the merge lives in `pi-coding-agent`'s `core/messages.d.ts`, which is the
 * CLI, not a dependency here -- so without this file `AgentMessage` is
 * `Message` alone and every `compactionSummary` the adapters build and the
 * clients draw stops typechecking (OW-meriva). The shapes are copied from
 * `pi-coding-agent 1.2.0`; the only difference from 0.84.1 is
 * `BranchSummaryMessage.fromId`, now `string | null`.
 *
 * No runtime code: this module exists for its `declare module` and is in the
 * program through `tsconfig.json`'s `include`, not through any import.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
