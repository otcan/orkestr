# Owned Claude sessions against the installed CLI

The owned Claude path (`provider: "claude"` in the private isolated execution
config, Deep role) was qualified end to end against the installed Claude Code
CLI 2.1.295 with a real subscription login, on an isolated candidate instance
with its own home, port and state. The first real turn never started; the
fixes below are what it took to make the closed codec accept the actual CLI.
Every fix keeps the codec closed: unknown frames still refuse the channel.

## Installed-CLI compatibility fixes

- **Device nodes.** The lifetime wrapper binds `/` without device access, so
  the Bun-based CLI aborted at startup. The wrapper now mounts a private minimal
  `/dev` (`--dev /dev`). Codex natives gain working `/dev/null` and nothing else.
- **Reasoning blocks.** Assistant `thinking`/`redacted_thinking` blocks are
  dropped (never forwarded or persisted). A reasoning-only frame emits nothing.
- **Input join key.** The CLI puts `user_message_uuid` only on the first
  assistant frame of a turn. Later blocks, and API messages after a tool
  result, omit it. Such a frame is accepted only after this turn's own
  explicitly correlated frame. One channel carries exactly one native input,
  so a fresh reader still refuses any uncorrelated or historical frame.
- **System notices.** `system` frames other than `init` (`ui_invalidate`,
  `api_retry`, `thinking_tokens`, `status`, task notices, ...) are a bounded
  discard (256 per channel). They can arrive before setup completes.
- **Stop.** The interrupt ACK reports `still_queued: []`; result frames carry
  extra telemetry (`subagent_stats`, `result_index`, ...); the interrupt notice
  carries `timestamp`. All are accepted and never forwarded.
- **Provider failures.** Assistant `error` (`authentication_failed`,
  `rate_limit`, `billing_error`, ... else `unknown`) is forwarded as a closed
  class so Runtime records Failed. Previously a missing login refused setup
  and left the input queued with no visible state.

## Host full access (operator opt-in)

`claude-private.json` may contain
`"host_full_access": {"environment": {"HOME": ..., "PATH": ..., ...}}`. It is
the Claude counterpart of the beta `host_full_access` instance option, set only
by the operator. When present the native:

- runs directly on the host as the service user (no user/PID namespace), so
  `sudo` works where the service user has it: equivalent to host root;
- receives `--dangerously-skip-permissions` and the full default tool set
  instead of `--tools "" --restricted --safe-mode`;
- gets exactly the operator environment plus the configured account reference
  (`CLAUDE_CONFIG_DIR`) and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (each turn
  is a new process; detached tasks would die while the turn reports success).
  The environment may not contain `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_CONFIG_DIR`: no silent account or billing
  route change.

Tool calls, tool results and subagent frames drain as a bounded discard; only
assistant text becomes progress. Provider frames may be up to 4 MiB (real init
and tool-result frames exceed 64 KiB); broker output keeps the 64 KiB bound.
Without a PID namespace, cleanup sweeps every adopted descendant of the
subreaper broker (setsid tool shells included) before reporting the reap
witness. An interrupt during a tool reports `aborted_tools`; it is the same
interrupted terminal for that exact input.

## Long runs and lease renewal

Claude runs renew their 60 s run lease like Codex Deep: every 20 s, under the
same scheduling lock as Stop and observation, once the input is fully written,
native identity is committed and no observation awaits its receipt. The same
native child, turn and observation cursor continue under the new fence; any
refused or uncertain transfer quarantines the child (no retry, no new turn).
The 45 s Claude budget cap is gone; `execution_budget.max_run_ms` has the
ordinary bound. Long tools emit `tool_progress` and `keep_alive` frames; both
are bounded discards. Claude background tasks stay disabled: each accepted turn
is a new native process, so a detached job would die with it (Worker detached
jobs belong to the workspace-exec profile, not to the Claude native).

## Qualification matrix (Deep role, real CLI, isolated candidate)

| Scenario | Result |
| --- | --- |
| Fresh turn, web input to accepted result | pass |
| Resume (`--resume`, same native UUID, context retained) | pass |
| Server restart, then resumed turn | pass |
| Stop while streaming (ACK and `aborted_streaming` terminal, reaped) | pass |
| Fresh input after confirmed Stop | pass |
| Follow-up while busy: queued, one run after acceptance | pass |
| Auth failure (empty account): `failed`, no progress, no fallback | pass |
| Quota (synthetic native, installed-CLI `rate_limit` frames): `failed` | pass, synthetic |
| Full access: Bash tool with `sudo -n`, resume, Stop during a tool | pass |
| Full access: 80 s tool run across 4 lease renewals, then Stop at 75 s | pass |

## Failure cause

A `failed` execution status carries `failure: {"class": ...}` when the provider
stated a closed class: `authentication` (not logged in or login rejected),
`quota` (usage or rate limit), `billing`, `provider` (invalid request, server
error, output limit) or `unknown`. Runtime takes only the first assistant
`error` class of the turn; provider text and account data are never stored.
The class is part of the committed observation digest, so a replay cannot
relabel it, and it is absent for every other phase and for unclassified
failures (Codex does not state a class). The web status line shows a short
cause, for example `Failed: provider usage limit reached`.

## Known limits

- Beta execution windows run Claude Deep, and optionally a Claude Fast
  companion, per conversation setting (see `claude-windows.md`). The isolated
  execution-config factory stays Deep-only for Claude. Claude Workers (typed
  Worker tasks under a Claude parent) are not implemented: Worker tasks in a
  Claude conversation are refused rather than run on Codex.
- Steer is unavailable; a follow-up stays queued until acceptance.
- Any single text block over 8 KiB refuses the turn (same per-item bound as
  Codex snapshots); the run becomes `blocked`, never a partial success.
- A real quota exhaustion was not induced; quota evidence replays the
  installed CLI's frame shapes through the real server and broker.

## Reproducing

`v2/acceptance/claude_provider_qualification.py` drives these scenarios
(`deep auth quota yolo followup`) against a freshly built server, with the
installed executable and account directory passed by reference. Each scenario
gets its own private home, workspace and loopback port; delete the `--root`
directory afterwards. Evidence holds phases, counts and short payload heads only.
