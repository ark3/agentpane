---
labels: [unverified, work-laptop]
blocked-by: [OW-tadoju]
closed: promoted
---

# agentpane's Pi store readers have only been checked against the home server's 13 session files, never against the work laptop's store

**Work laptop:** the owner pulls `main`, runs OW-tadoju's store survey over that machine's `~/.pi/agent/sessions` by hand, and brings its output back to the home server.

Filed 2026-10-14.
Pi is used daily on the work laptop and rarely on the home server, so the work laptop's store spans more Pi versions, more extensions and MCP use, and far more sessions than the 13 the home server held on 2026-10-14.
It is the store most likely to hold an entry type, message role or field that `src/server/sessions/pi.ts` and `storedAgentMessage` in `src/server/sessions/preview-message.ts` have never seen.

OW-tadoju's probe prints structure only, never content, which is what makes running it over that store acceptable; do not substitute an ad hoc read of the files.
No agent session runs on the work laptop (AGENTS.md, "What is still confined to the work laptop"), so the visit is the one command, and everything else this card asks for happens in a home-server session once the output is back.
How the output travels — committed on the work laptop and pulled, or carried by hand — is the owner's call.

## The visit

From the root of the work laptop's agentpane checkout, after pulling `main` (no `bun install` needed):

    pi --version
    bun resources/probes/pi_store_survey.ts > /tmp/pi-store-survey.txt

If Pi keeps its sessions elsewhere on that machine (`PI_CODING_AGENT_DIR`, or a `sessionDir` setting), pass that directory as the probe's one argument.
Skim `/tmp/pi-store-survey.txt` before carrying it off the machine: the probe prints no values, paths or names, but it prints any identifier-shaped key an extension put at a schema position, and its docblock says so.
Bring back both outputs; the survey's first line counts the session files it read, which is the number the done-condition asks for.

## On the home server, once the output is back

Compare it with the home server's run in `docs/MANUAL_TESTING.md`, "The home server's Pi store, surveyed for what agentpane does not read (OW-tadoju)".
That section's "Not seen in this store" paragraph names the entry types and roles `pi 1.2.0` declares that the home server's store never held; what the deck carries for them as of 2026-10-14: a `compaction` entry is OW-livowu, an in-file branch is OW-gogoka, `session_info` is OW-yilene, a header's `parentSession` is OW-vezipo, and nothing yet carries `custom_message`, `branch_summary`, `context_edit`, `label` or `usage` entries, the `bashExecution`, `custom` or `branchSummary` roles, or a `message(user)` whose `content` is a `string` (which `extractUserMessageTexts` in `src/server/sessions/pi.ts` skips for the listing preview).

## Done when

The survey's output from the work laptop's store is recorded in `docs/MANUAL_TESTING.md` with the date, that machine's `pi --version`, and the number of files surveyed.
Every shape in it that the home server's run did not show, and that agentpane mishandles, gets a card filed on the home server, or is added to the open card that already carries it.

## Close note

Promoted to ark3/agentpane#35 during the card triage, 2026-11-01, wanted soon by the owner; the issue carries the visit's exact commands.
