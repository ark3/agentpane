---
labels: [unverified, work-laptop]
blocked-by: [OW-tadoju]
---

# agentpane's Pi store readers have only been checked against the home server's 13 session files, never against the work laptop's store

**Work laptop:** run OW-tadoju's store survey over that machine's `~/.pi/agent/sessions` and record what it prints.

Filed 2026-10-14.
Pi is used daily on the work laptop and rarely on the home server, so the work laptop's store spans more Pi versions, more extensions and MCP use, and far more sessions than the 13 the home server held on 2026-10-14.
It is the store most likely to hold an entry type, message role or field that `src/server/sessions/pi.ts` and `storedAgentMessage` in `src/server/sessions/preview-message.ts` have never seen.

OW-tadoju's probe prints structure only, never content, which is what makes running it over that store acceptable; read its docblock before running it, and do not substitute an ad hoc read of the files.

## Done when

The survey's output from the work laptop's store is recorded in `docs/MANUAL_TESTING.md` with the date, that machine's `pi --version`, and the number of files surveyed.
Every shape in it that the home server's run did not show, and that agentpane mishandles, gets a card filed from the same visit, or is added to the open card that already carries it.
