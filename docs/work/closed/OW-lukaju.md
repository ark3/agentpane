---
labels: [question]
closed: done
---

# What Pi's mid-stream fork costs the user is smaller than the "Stop and ..." warning assumes

`src/client/controller.ts` `forkAndSubmit` aborts a running Pi turn before forking, and `src/client/App.svelte` labels the affordance "Stop and ..." — the docblock above those labels calls it "the only warning the user gets."
D15 in `docs/DESIGN.md`, under "**Pi leaves no choice.**", is the decision behind it.

That warning was written when the repo believed a mid-stream Pi fork destroyed the in-flight turn's output entirely.
It does not.
Measured on the home server, 2026-09-15, `pi 0.85.1` on `deepseek/deepseek-v4.1-flash`, with the probe holding the fork until forty `text_delta`s had accumulated and re-reading the count at the instant the request went out: 47 deltas were on the wire and the file the turn was streaming into kept the reply's first 447 characters.
See `docs/MANUAL_TESTING.md`, "Pi's mid-stream fork, measured against text known to have streamed (OW-sededi)".
What the fork actually costs is the *rest* of the reply, plus the branch it was on — not the bytes already streamed.

## The question

Whether that changes the warning the user gets, and if so how.
Two things pull against each other and the owner has not weighed them:

- The partial reply survives on the abandoned branch's session file, which is a real file in the sessions directory that `src/server/sessions/walk.ts` walks into the picker.
  So the text is not gone from disk; it is gone from the branch the user is now on.
- Whether the user can actually reach it is a separate matter, and is the territory of OW-vezipo — a fork's row and its parent's are still character-for-character identical, so "it's still there, in the other session" may be advice nobody can follow.

D15 itself is not in doubt: Pi stops the turn whatever agentpane does, so the abort does not cause the loss and the choice is only whether the user is told.
The question is what the telling should say now that the loss is partial and the remainder is on disk.

## Done when

The decision is recorded where the next reader will look — D15 in `docs/DESIGN.md`, since that is what the label's docblock cites — saying either that the "Stop and ..." framing stands as written and why, or what it becomes.
If it becomes something, the label and the docblock in `src/client/App.svelte` and `src/client/controller.ts` follow in the same change.
Deciding it stands is a close; leaving D15 describing a total loss it has been measured not to be is not.

Filed 2026-09-15 out of OW-sededi, whose run produced the measurement and whose conditional this answer fit neither branch of.

## Close note

The owner decided on 2026-09-15: the edit banner's sentence stays exactly as it is — "Editing an earlier message. Forking starts a new conversation from here and keeps this one." — and says nothing about the partial reply a stopped Pi turn leaves in the kept conversation.
His reason, in his words: he is agentpane's only user and he understands what the fork costs.
The alternative put to him was extending that sentence to "... and keeps this one, with whatever the running turn had already written".

Recorded in `docs/DESIGN.md` D15 under "**The warning stays as it is, and says nothing about the surviving prefix.**", which also retires the clause that had left the framing question open, and in the edit banner's own docblock in `src/client/App.svelte`, so a reader at the sentence learns the silence is a decision rather than an omission.
No user-facing string and no behaviour changed; the commit is comment-and-prose only (`bun run check` passes, 50 files, 1094 tests).

Two things were put to the owner and did not decide it, kept in D15 as what to re-read if this reopens: the banner's prose is pinned by no test while both button strings are pinned in `src/client/App.test.ts` (and "Stop and edit" again in `e2e/composer-shortcut.spec.ts`), so the cheap change was the one on offer; and the surviving prefix sits in the pre-fork session, which `list()` keeps since OW-kekoji but whose row carries the same preview label, backend and workspace as its fork's with nothing marking which is the pre-fork branch — OW-vezipo — so promising the text was there would have pointed at a row nobody can pick out.

An adversarial reader dispatched at the written decision caught three defects, all fixed before this close: reasoning of the writer's presented where it read as the owner's, an overstatement that both button strings were pinned in two Playwright specs (only "Stop and edit" is, in one), and "character-for-character" for the two sidebar rows, which the attached stripe and accessible name contradict.
