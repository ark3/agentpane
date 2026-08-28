/**
 * Claude Code injects these wrapper forms into user-role store and live lines.
 * They are transport context, not human-authored transcript turns.
 */
const SYNTHETIC_USER_PREFIXES = [
	"<system-reminder>",
	"<command-name>",
	"<command-message>",
	"<local-command-caveat>",
	"<local-command-stdout>",
	"<task-notification>",
	"[Request interrupted by user",
];

export function isSyntheticClaudeUserText(text: string): boolean {
	const trimmed = text.trimStart();
	return SYNTHETIC_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}
