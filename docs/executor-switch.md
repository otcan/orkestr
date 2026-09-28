# Executor Switch (Codex <-> Claude Code)

An Orkestr thread has exactly one active executor: the Codex app-server runtime
or the Claude Code runtime. The owner can switch a thread between them in place,
for example to use another provider's quota or a different flagship model for a
specific task. There is no automatic quota failover; every switch is explicit.

A switch keeps everything that identifies the thread:

- the same thread id, title, and connector bindings (for example a WhatsApp chat)
- the same message history
- the same working directory, repository, and branch
- the same owner, release role, standing mission, timers, and security profile

Only the executor, its model settings, and its session change.

## Commands

Thread commands work the same from connected chats, the web UI, and
`orkestr send`:

| Command | Effect |
| --- | --- |
| `/agent` | Show the active executor, model, and effort. |
| `/agent claude [model]` or `/claude [model]` | Switch to Claude Code. |
| `/agent codex [model]` or `/codex [model]` | Switch to Codex. |
| `/agent <executor> [model] now` | Interrupt the active turn and switch immediately. |
| `/model <name>`, `/effort <level>` | On a Claude Code thread, set the Claude model or effort (low, medium, high, max) from the next turn on. On a Codex thread they keep their Codex meaning. |
| `/fast` | Codex only. |

`/switch api` and `/switch terminal` choose the Codex runtime surface. On a
Claude Code thread they are rejected with `409
claude_code_runtime_surface_switch_unsupported`; switch to Codex with
`/agent codex` first. `/agent api` and `/agent terminal` keep the runtime surface
meaning.

If `ORKESTR_CLAUDE_CODE_MODELS` is set (a comma-separated list), Claude model
names must be in that list.

## API

```text
GET /api/threads/:id/executor
PUT /api/threads/:id/executor
```

`GET` returns the active executor, runtime kind, model, effort, Claude account
profile id, a summary of the stored executor states, and any pending switch.
Session secrets are never returned.

`PUT` body:

```json
{ "executor": "claude", "model": "opus", "effort": "high", "profileId": "llm_example", "when": "after_turn", "reason": "use the other quota" }
```

- `executor`: `codex` or `claude` (`claude-code` is accepted).
- `when`: `after_turn` (default) or `now`. It only matters while a turn is
  running.
- `profileId`: optional Claude account profile. The default is the profile the
  thread used the last time it ran on Claude Code, then the owner's most recently
  verified ready Claude profile.

Authorization follows the thread owner/admin controls. Switching to Claude Code
is admin-only and limited to the admin's own non-contained threads, exactly as
for creating a Claude Code thread, and needs a ready Claude account profile.

## CLI

```text
orkestr switch <thread> [codex|claude] [--model m] [--effort e] [--profile id] [--now] [--reason text] [--json]
orkestr switch --self codex|claude --reason text [--model m] [--json]
```

`orkestr switch <thread>` without a target prints the active executor.
`--self` resolves the calling agent's own thread the same way as
`orkestr whereiam` (working directory and API session id).

## Deferral and interruption

When a turn is running, a switch with `when=after_turn` is stored as the
thread's pending switch and applied when the turn finishes, from the
turn-completion path of whichever executor is active (completed, failed, or
interrupted). `when=now` interrupts the active turn with the normal interrupt
path and applies the switch as soon as the turn has stopped.

Inputs are handled by whichever executor is active when they are delivered;
inputs still queued when the switch applies go to the new executor.

## State and cleanup

Before switching, the current executor's resumable settings are stored in
`thread.executorStates.<executor>`:

- Codex: Codex thread and session ids, model, reasoning effort, service tier,
  rollout path.
- Claude Code: account profile id, model, effort, permission mode.

No secrets are stored there. Every routing field of the old executor is then
removed from the thread (not just blanked), so the old runtime can never be
mistaken for the active one. Switching back restores the stored settings:

- Codex resumes its previous Codex thread when it still exists (and starts a new
  one otherwise).
- Claude Code reuses the previous account profile, model, and effort. Every
  switch rotates the thread's Claude policy revision, so a Claude session from
  before a switch is never silently resumed with outdated context; Claude starts
  a fresh session and receives the handoff instead.

If the target executor fails to start, the thread is rolled back to its previous
executor state and the API returns `executor_switch_start_failed`.

Every switch is audited as a `thread_executor_switched` event with `from`, `to`,
`actor`, `reason`, and `when`; failures are audited as
`thread_executor_switch_failed`.

## Handoff

Each switch writes an executor-neutral handoff file under the thread's
`context-checkpoints` directory. It contains:

- a plain statement that this is the same thread with the same owner and the
  same authority, which executor ran before, and that the new executor is now
  the active agent for the thread
- the thread's release role line (a thread is only described as a worker when
  it has a parent thread)
- the standing mission, if set
- working directory, branch, HEAD, and `git status --short` (best effort, time
  bounded)
- pending queued inputs and open timers counts
- the previous executor's last final answer
- the last 40 messages, or, when an executor resumes its own previous session,
  only the messages since it last ran

The handoff is delivered once, as the preamble of the next turn the new
executor starts, and is then cleared. Tuning:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORKESTR_EXECUTOR_HANDOFF_MESSAGES` | `40` | Messages included in the handoff. |
| `ORKESTR_EXECUTOR_HANDOFF_MESSAGE_CHARS` | `4000` | Per-message character cap. |
| `ORKESTR_EXECUTOR_HANDOFF_MAX_CHARS` | `60000` | Preamble character cap. |
| `ORKESTR_EXECUTOR_HANDOFF_GIT_TIMEOUT_MS` | `3000` | Git snapshot timeout. |
| `ORKESTR_EXECUTOR_SWITCH_INTERRUPT_WAIT_MS` | `10000` | How long `when=now` waits for the interrupted turn to stop. |

## Agent self-switch

An agent may ask to move its own thread to the other executor with
`orkestr switch --self <executor> --reason <text>` (API: `actor: "self"`). A
self-switch is always applied after the current turn, requires a reason, and is
limited to one per thread every 10 minutes
(`ORKESTR_EXECUTOR_SELF_SWITCH_INTERVAL_MS`). The same authorization rules as an
owner switch apply.

## Workers

Worker threads created from a parent copy the parent's current
executor at creation time. Switching a parent later does not switch existing
workers.
