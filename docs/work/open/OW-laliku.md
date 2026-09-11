---
labels: [unverified]
---

# thread/fork omits the sandbox policy agentpane sets on every other thread path, so a forked Codex thread may silently run read-only

`src/server/adapters/codex/adapter.ts`: the `fork` method's `client.request<ThreadForkResponse>("thread/fork", ...)` call, read against the `thread/start` and `thread/resume` calls in `start()`.

agentpane sets its sandbox policy explicitly on every thread-creation path but one.
`start()` passes `sandbox: this.sandbox` to both `thread/resume` and `thread/start`, where `this.sandbox` falls back to `DEFAULT_SANDBOX`, `"danger-full-access"`.
The `thread/fork` call passes `threadId`, `lastTurnId`, `cwd` and `ephemeral`, and no `sandbox`.
`resources/codex-protocol/v2/ThreadForkParams.ts` accepts both `sandbox` and `approvalPolicy`, so the omission is agentpane's choice and not a protocol limit.

What it costs turns on something nobody has checked: whether a forked thread inherits the parent's policy server-side, or falls back to app-server's own default.
The `codexCommand` docblock in `src/server/adapters/codex/process.ts` records that default for the injected-flag case -- app-server "ignores it and defaults each thread to `read-only`".
If fork takes the same path, every forked Codex session runs read-only under a parent running `danger-full-access`, and the first write the forked agent attempts fails for a reason nothing on screen explains.
If fork inherits, nothing is broken and the asymmetry wants a sentence rather than a fix, so the next reader does not file this again.

This is not the fork-semantics question OW-mewiga and OW-gojado cover.
Those establish what `thread/fork` mints and whether the parent turn survives; neither reads a policy back off the forked thread.

## Needs a live Codex run, not a work-laptop trip

`codex` is installed on the home server, and only Pi is confined to the work laptop.
`resources/probes/fork_probe.py` is the vehicle, and OW-gojado is already queued to add a cell there, so one sitting can answer both.

The read is cheap, which is the main thing to know before scheduling it.
`resources/codex-protocol/v2/ThreadForkResponse.ts` returns `approvalPolicy` and `sandbox` on the fork response itself, so the effective policy can be read directly rather than inferred from whether a write succeeds.

## Done when

A probe cell forks a Codex thread from a parent started the way the adapter starts one, and records the `sandbox` and `approvalPolicy` the fork response reports, in `docs/MANUAL_TESTING.md`, phrased over what was seen.

Then the code stops being ambiguous either way: `thread/fork` carries the policy the way the other two paths do, or the `fork` method gains a sentence saying forks inherit and naming the run that showed it.

Whatever the response reports, record what it means for OW-18.
That card is adding `approvalPolicy` to agentpane's thread-creation paths, and if a fork does not inherit, it has this same hole and has to set both fields on all three paths rather than on start and resume alone.
