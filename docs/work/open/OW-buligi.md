---
labels: [defect]
---

# A Codex fork previewed from the list shows only its own turns, because its rollout holds none of the history it inherited

Found by OW-fojike's live run on the home server, 2026-09-22, `codex-cli 0.156.0`; the evidence is `docs/MANUAL_TESTING.md`, "The native Emacs mode forks a Codex session live (OW-fojike)", paragraph "The fork's stored transcript lacks what it inherited".
In service of a forked Codex conversation reading whole when reopened, in the browser or in Emacs, without attaching.

A Codex fork's rollout opens with a `session_meta` whose `forked_from_id` names the parent and then holds only the turns sent after the fork.
`src/server/sessions/codex.ts`, which projects a rollout into the stored transcript a preview draws, does not follow `forked_from_id`, so `bun run src/emacs/dump-nodes.ts codex/<fork id>` answered two nodes where the live buffer, attached, had drawn four.
The listing's preview for the fork was likewise its own first post-fork prompt rather than the first prompt it inherited, which bears on OW-vezipo's premise that a fork's true preview is its parent's first user message.

Load-bearing and unmeasured: where the fork's inherited history ends in the parent's rollout (the fork point), and whether a rollout names it at all; the `sessions/codex.ts` docblock already says `forked_from_id` is not reliably present on subagent rollouts, so a fork without it must still preview as today.
Nor was it checked whether the attached view survives a server restart, since attach reads through `thread/resume` rather than the rollout projection.

Done when a test fed a parent rollout and a fork rollout carrying `forked_from_id`, shaped as 0.156.0 writes them, projects the fork with the inherited turns ahead of its own, red before the change.
