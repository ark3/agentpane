---
labels: [question]
---

# Detach is offered during a compaction the backend does not report as streaming

Found while reviewing OW-tewave.

The Compact item in the composer's Tools menu guards on `compaction !== null`; the Detach item added by OW-tewave does not.
Its predicate is D12's reaper exemption -- attached or virtual, not streaming, no pending request -- plus `!view.sending`, and the owner chose exactly that on 2026-09-16.

`streamingAction`'s docblock in `src/client/App.svelte`, a few lines below `detachable`, says Codex and Claude expose a compaction through their generic active-turn signals.
Read against that, a backend that does *not* -- Pi is the candidate -- would sit mid-compaction with `isStreaming: false`, `requests: []`, `sending: false` and an `attached` summary, and Detach would be offered.
`close()` then kills the subprocess mid-compaction, which is the same class of loss the `isStreaming` conjunct exists to prevent (OW-japuzo).

This is filed as a question and not a defect because the Pi half is read from that adjacent docblock and has never been measured, and because the predicate is an owner decision that a fifth conjunct would amend.

Done when the measurement exists and the decision is recorded: run a compaction on Pi on the home server (`pi --model openrouter/deepseek/deepseek-v4.1-flash:high`, naming the version) and read whether `isStreaming` covers it, record that in `docs/MANUAL_TESTING.md`, and then either add `compaction === null` to `detachable` with a test that goes red first, or record in `docs/DESIGN.md` D12 why the predicate stays at four conjuncts.
Both branches close this card; neither is a skip.
