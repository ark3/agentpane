---
labels: [defect]
closed: done
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

## Close note

Landed on main as a0c516b and fed1b6e, with a274200 retiring a contradicted doc claim.

The fork point is named, not guessed: a Codex fork's `session_meta` carries `history_base: {thread_id, end_ordinal_exclusive, end_byte_offset}` (and `forked_from_ordinal_exclusive`), measured on `codex-cli 0.156.0` and on all 19 based rollouts in the home server's store (18 from 0.154.0).
The ordinal counts records over the named thread's whole ancestry and the byte offset within its own file, settled for a fork of a fork by `resources/probes/codex_fork_history_probe.py` on 0.156.0 with `gpt-5.6-luna`; a fork cut inside inherited history names its grandparent, which is why `history_base`, not `forked_from_id`, is followed.
Subagent rollouts carry `forked_from_id` but no `history_base` (43 of them, 0.150.1 to 0.154.0) and repeat their parent's records inline, as the 0.147.0 fixture fork does, so they are projected as before.
Evidence: `docs/MANUAL_TESTING.md`, "A Codex fork's rollout names where its inherited history ends (OW-buligi)".

`extractCodexPreviewTurns` in `src/server/sessions/codex.ts` now projects the base rollout's records below the ordinal (its own base first) ahead of the fork's own, locating the base by filename through the same readdir walk `readSessionPreview` in `src/server/sessions/preview.ts` already did; a fork whose base is not in the store previews its own turns, as before.
Against the real store the OW-fojike fork previews four turns where it previewed two, and the parent's six are unchanged.
A previewed Codex fork's stored indices now line up with the live fork points, which bears on OW-gekiki.
The listing's preview for a based fork is unchanged (still its own first prompt; OW-vezipo's question).
Whether an attached fork's view survives a server restart was not tried.

Verified by `bun run check`, 1175 tests; the tests in `src/server/sessions/preview.test.ts` for a fork, a fork of a fork, and a base naming the grandparent were red first, and the subagent and missing-base guards were shown red by breaking the fix.
`docs/MANUAL_TESTING.md` had called `lastTurnId` exclusive; the measurement shows it inclusive, as the adapter already said, and a274200 corrects it.
Filed from this card: OW-hojefo, the fork at the first user message.
