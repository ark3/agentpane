# D7a. Codex approval policy: `never`, set by the adapter

agentpane sets `approvalPolicy: "never"` on every Codex thread it creates, rather than inheriting Codex's `on-request` default.
The intent is to avoid permission prompts, not to route them into agentpane's UI: agentpane has no approval dialog, so an approval `ServerRequest` is refused at arrival -- declined where it has a decline shape, errored out otherwise -- and named in a session error (D2a).
When this was decided the trade was "no dialog" against "a hung turn", and the hung turn is worse; since OW-zisumi what `on-request` would cost instead is an approval refused at arrival.

The site is `CodexAdapterOptions.approvalPolicy` in `src/server/adapters/codex/adapter.ts`, beside `sandbox`, applied at thread creation exactly the way `sandbox` is.
Not sbox: sbox injects its flags before the subcommand (`codex --sandbox danger-full-access app-server`), and a CLI approval flag there would be the same no-op the sandbox flag already is for `app-server` (OW-37).
Not `~/.codex/config.toml`: the `-c approval_policy=never` route `app-server` does accept would put a hidden global outside the repo, contradicting an adapter option that sets the sibling policy and invisible to `bun run check`.

Both policies go on **all three** thread-creation paths — `thread/start`, `thread/resume`, and `thread/fork`.
`thread/fork` is not symmetry for its own sake.
The OW-18 run found that a fork inherits the parent's `approvalPolicy` but **not** its `sandbox`: forking a `dangerFullAccess` parent with only `threadId` and `cwd` returned a thread reporting `workspaceWrite`.
The copied `~/.codex/config.toml` sets no sandbox key, so that value is app-server's own default rather than the operator's configuration; the probe records the config's key names for exactly that reason.
Passing both explicitly repairs that downgrade.

What the policy buys today is insurance rather than a behaviour change: under the `danger-full-access` sandbox agentpane already uses, no approval arrived under either policy, so `never` was not shown to be doing work today and bites only if that sandbox setting ever narrows.
Where it did bite — a `read-only` thread — the suppression is not a silent grant: that cell ended with `notes.txt` unchanged and no `fileChange` item completed, while the assistant's text claimed the edit was made.
The run did not establish whether the tool call was refused or never issued, and did not read the turn's final `status`.
