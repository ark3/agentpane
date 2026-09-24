---
labels: [unverified]
closed: done
---

# The browser controller's setModel gate against a conversation with messages has no test

`setModel` in `src/client/controller.ts` returns early once the selected session has any messages -- the browser's half of the model gate, which the server does not enforce.
No test in `src/client/controller.test.ts` pins that return; the existing `setModel` tests cover the pending flag, a second call while one is in flight, and a rename, all on an empty conversation.
Its sibling `setEffort` has exactly that test, "never sets an effort once the conversation has a message", which landed with OW-kivahe and is the shape to copy.
Found while reviewing OW-kivahe on 2026-09-23.

## Done when

- A test in `src/client/controller.test.ts` calls `setModel` on a selected session whose snapshot carries a message and asserts `api.setModel` was not called and `modelSetting` stays false, shown red by removing the messages check from `setModel`'s gate.
- `bun run check` passes.

## Close note

Added "never sets a model once the conversation has a message" to `src/client/controller.test.ts`, beside the setModel tests and mirroring setEffort's "never sets an effort once the conversation has a message".
It emits a snapshot carrying one user message, previews the session, calls `setModel`, and asserts `api.setModel` was not called and `modelSetting` stays false.
Shown red by removing `|| view.state.sessions[sessionKey(selected)]?.messages.length !== 0` from `setModel`'s gate in `src/client/controller.ts`: the spy was called once with the session ref and "opaque/next".
Green with the gate restored; `bun run check` passed, 54 files and 1256 tests.
