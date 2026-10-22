# Claude Deep in execution windows

A conversation whose owner settings select Claude (`PUT …/settings`,
`provider: "claude"`; see conversation resources) runs its Deep turns on
Claude inside the ordinary beta execution window: same durable intake, window
admission, capacity and queue, Stop, acceptance and retirement as Codex. The
operator installs the runtime; the owner only chooses it per conversation.

## Operator installation

The root-owned service package gains, together:

- `launcher-claude.py` (fixed `entry.py broker-claude` launcher),
- `claude-private.json` (`executable`, `account`, `workspace`, `home`,
  `temporary`, `host_full_access.environment`) and
- the `broker/claude_*.py` modules.

The selected-service packager does this from the plan's optional
`"claude": {"executable", "account", "workspace", "home", "temporary",
"default"?, "fast"?}`. It requires `host_full_access` and reuses its
environment, never opens the account directory, and refuses an environment
that carries an account or API key. `beta.json` gets `"claude": {"launcher", "launcher_sha256", "workspace",
"default"}`. `default: true` runs conversations whose settings were never
changed on Claude. The account is a path reference (an existing logged-in
`CLAUDE_CONFIG_DIR`); the package never reads or copies it. Only host full
access (V1-equivalent, `--dangerously-skip-permissions`) is supported for
Claude windows; the manager pins the stopped `broker-claude` launcher exactly
like the Codex roles. With `claude` configured the server enables Claude
selection in conversation settings (`with_claude_turns`).

## Behaviour

- Each Claude turn is a new native process in the window, resuming the same
  native session (`--resume`). Follow-up input joins the live window.
- The conversation's `model` and `reasoning_effort` apply from the next launch
  (`ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`), never to a running turn.
- Stop confirms the native interrupt and retires the window; the next input
  opens a successor window that resumes the session. A successor admission may
  briefly answer `503 window_unavailable` (retryable) until the root manager
  has retired the stopped window.
- Run leases renew as for Codex; the window work deadline cancels through Stop.
- With `"fast": true` in `beta.claude`, each input is also presented on a
  Claude Fast companion: a distinct Fast native binding and session, lowest
  effort, its own Stop (`…/fast/stop`) and owner acceptance, resumed per
  presentation exactly like Deep. Workers and the descriptor workspace profile
  stay Codex-only for Claude conversations.
- A lost or failed Fast companion (Codex or Claude) fails alone: it is logged,
  marked failed and stops presenting; Deep and Workers keep the window and keep
  serving turns. A Fast that is neither ready nor presenting 15 s after Deep
  starts waiting for it (for example one that never gets its input) is marked
  failed the same way, and Deep activates the window without a Fast scope.
  Core's activation never needed Fast; only Fast waits for Deep's activation.
  A dispatch Fast already claimed is never abandoned mid-flight. Retiring that window still goes through Core, which refuses
  an unresolved Fast run, so the window ends in reconciliation, not closed.
- Claude account rate-limit telemetry is drained with only a size/shape bound:
  the installed CLI added `overageEnabled`, and the closed field list lost a
  live Fast turn on it.
- Switching provider after a conversation already has a committed native
  identity of the other provider is refused at window admission (`409`) until
  the handoff path exists; new or untouched conversations may select either.

## Validation

`tests/service_claude_window_http.py` (root) drives the real service package,
root manager and HTTP server: settings selection, fresh turn, same-window
follow-up (`--resume`), Stop in the window, successor window resume. CI runs it
with a synthetic native; with `--executable`/`--account` and the service
identity in `ORKESTR_FIXTURE_SERVICE_UID/GID` it ran against the installed
Claude CLI (context kept across all four turns and two windows).
