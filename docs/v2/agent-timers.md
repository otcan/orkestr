# Agent timers: a thread's agent manages its own timers (TASK-52)

A running Deep turn can list, create, cancel, pause, resume and skip the
timers of **its own conversation**. The path is V2-only. It replaces agents
calling the V1 timer API (`/api/threads/<id>/timers`, `api-client.js`,
`deltimers.mjs`), which V1 now refuses for V2-owned timers
(`timer_owned_by_v2`).

## Authority

The design is the thread-ask grant's (#341, migration 78), with its own grant:

- The owner issues a grant per conversation:
  `PUT /api/v2/conversations/{id}/agent-timer-grant`. The grant is shown once
  and only its hash is stored. A new issue rotates it, `DELETE` revokes it,
  and `GET /api/v2/agent-timer-grants` lists every conversation's grant state
  for provisioning (never a grant value).
- A thread-ask grant is not a timer grant, and a timer grant is not a
  thread-ask grant.
- The agent sends the grant in `x-orkestr-agent-timer-grant`, with no cookie,
  bearer or Origin. The grant works only while its conversation has a
  dispatched Deep run (`starting` or `running`), and every step records that
  run in the audit. The grant is checked in a read transaction before the
  write lock is taken.
- **Own conversation only.** No request names a conversation (unknown fields
  are refused). A created timer is mapped to the grant's conversation
  immutably and enabled there under a durable grant, so it can never fire
  into another conversation. Any timer of another conversation reads as
  `404 agent_timer_not_found`.
- **Fast never gets this tool.** Fast runs in the read-only sandbox, is never
  given the grant (never set `ORKESTR_V2_AGENT_TIMER_GRANT_DIR` for Fast), and
  a Fast run does not satisfy the running-Deep check.
- Any Deep turn of the conversation may use it, including a turn serving a
  group member. This differs from thread asks, which only the owner's own
  message may command: a timer step can only affect this conversation, and the
  caps below bound it.
- **No self-perpetuating chains.** A turn that a timer started may list,
  cancel, pause, resume and skip timers (a check timer pauses itself after its
  end date). It may also create **one-shot** timers (meeting reminders), but
  never a **recurring** one (`403 agent_timer_timer_turn`). A one-shot fires
  once, and the hourly and daily create caps still apply, so timers can never
  keep themselves going beyond 24 creates a day.

## Operations

| Route (grant holder) | Effect |
|---|---|
| `GET .../agent-timers` | Every timer of this conversation: owner-created, imported from V1 and agent-created (`created_by_agent`). |
| `POST .../agent-timers` | Create and enable one. Body: `request_key`, `label`, `schedule` (`{"kind":"once","due_ms":...}` or a calendar rule `{"kind":"calendar","timezone":...,"weekdays":[...],"start_minute":...,"end_minute":...,"every_hours":1,"minutes":[...]}`), `text`. 201, or 200 for a replay of the same key and body. The same key with another body is `409 agent_timer_conflict`. |
| `POST .../agent-timers/{namespace}/control` | `{"request_key":...,"operation":"cancel"\|"pause"\|"resume"\|"skip_next","until_ms":...}` |

- `cancel` disables the timer: no further runs. The owner can re-enable it.
  Stop and rollback stay owner-only (`400` for any other operation).
- `pause` sets the timer's pause until `until_ms` (default and maximum: 60
  days). `resume` lifts it. A run that came due while paused is not replayed.
  An owner's indefinite pause can be neither lifted nor replaced by the
  agent (`409 agent_timer_owner_paused`).
- A dormant import (never enabled in V2, so V1 may still own and run it) is
  listed but not controllable (`409 agent_timer_dormant`): only a V2-enabled
  timer can be cancelled, paused, resumed or skipped.
- `skip_next` drops exactly the next run of a recurring timer (it pauses until
  just after that run). A one-shot timer cannot skip, only cancel
  (`agent_timer_skip_once`).
- A control step with a request key already accepted for the same timer and
  operation replays (`changed: false`). Repeating a step that is already in
  effect also changes nothing.
- **Retries must reuse the key.** `agent_timer.py` prints the request key of
  every change before sending it, and again on failure (with the exact rerun
  hint). After a failure or a lost response, agents rerun the same command
  with `--request-key KEY`. This matters most for `skip-next`: its default key
  names the next run, and after a lost but accepted response the next run has
  moved, so a fresh key would skip a second run.
- Every run of an agent-created timer receives its text behind one line that
  says the agent set it with this tool (not the owner just now).

## Caps

| Cap | Value | Refusal |
|---|---|---|
| Live agent-created timers per conversation (enabled or paused; owner and imported timers do not count) | 32 | `429 agent_timer_limit_reached` |
| Creates per conversation per hour | 12 | `429 agent_timer_rate_limited` |
| Creates per conversation per 24 hours | 24 | `429 agent_timer_daily_limit` |
| Recurring creates from a turn a timer started | none (one-shots allowed) | `403 agent_timer_timer_turn` |
| One-shot lead time | at least 2 minutes ahead | `422 agent_timer_too_soon` |
| Horizon | at most 400 days ahead | `422 agent_timer_too_far` |
| Recurring interval | never more often than every 30 minutes | `422 agent_timer_too_frequent` |
| Pause length | at most 60 days | `422 agent_timer_pause_invalid` |
| Audited refusals per conversation per 10 minutes | 20, then refused without any write | `429 agent_timer_rate_limited` |

A replay is never refused by the create caps; over the refusal budget every
write request, a replay included, is refused until the window passes. Every authenticated attempt, accepted or
refused, is appended to `agent_timer_audit` (conversation, run, grant
generation, operation, timer, request key, outcome, time). The audit and the
`agent_timers` provenance rows are append-only.

## Agent tool

`v2/tools/agent_timer.py` (same pattern as `thread_ask.py`). The grant comes
from `ORKESTR_V2_AGENT_TIMER_GRANT`, a private `--grant-file`, or
`ORKESTR_V2_AGENT_TIMER_GRANT_DIR/<conversation>.grant`:

```sh
agent_timer.py list
agent_timer.py create --label "Biocytogen 12:15" --at 2026-10-27T12:00:00+01:00 --text "..."
agent_timer.py create --label "CHECK 08:00" --daily 08:00 --timezone Europe/Berlin --text "..."
agent_timer.py cancel "Biocytogen 12:15"
agent_timer.py pause "CHECK 08:00" --until 2026-11-03T08:00:00+01:00
agent_timer.py resume "CHECK 08:00"
agent_timer.py skip-next "CHECK 08:00"
agent_timer.py instructions
```

A timer is named by its ID or exact label. The default create key comes from
the label, schedule and text, so a retried create is the same timer.

## Provisioning

`v2/tools/agent_timer_provision.py --v2-url URL --credentials FILE --grant-dir
DIR --only <conversation> [--rotate] [--revoke] [--chown USER] [--dry-run]`
issues and installs grants as `DIR/<conversation>.grant`. The default and
recommended scope is one conversation (`--only`). `--all-owner-conversations`
refuses unless `--i-understand-shared-grant-dir` is also given, because every
grant then sits in one directory. The script creates DIR owned by the caller
with mode 0710 and the `--chown` user's group (0700 without `--chown`): the
agent user can enter it and open its own file but cannot list it. Each grant
file is 0600 and owned by the `--chown` user, which is the agent that reads it
(`agent_timer.py` refuses a grant file owned by anyone else). An existing DIR of
another user must not be group- or world-writable. Reruns change nothing; a missing file or
`--rotate` rotates; restricted or archived conversations are revoked. Use a
directory separate from the thread-ask grants and readable only by the Deep
agents' user. Grants are owner-scoped, not thread-isolated: a process that can
read DIR can use any conversation's grant (for that conversation only).
Per-run broker injection is the follow-up, as for thread asks.

Nothing is enabled live by this change: no grant exists until the operator
provisions one.

## Deployment and rollback

Migration 79 adds three tables and nothing else. It needs migration 78 (#341,
thread asks) first. #348 (parallel Fast) renumbers to 80 and ships after it.
V2 migrations must be contiguous in deployment order. Preflight checks the
applied `_sqlx_migrations` rows position by position against the source list.
A database that applied 80 before 79 would therefore not open.

The release train treats any schema change this way: when a release's
migration rehearsal reports a changed schema, a failed health check leaves the
new release running for operator recovery. It never starts the old binary on
the migrated database, because the older binary refuses a newer schema at
preflight. This applies to every migration, not only this one.

There are no down-migrations in V2 (SQLx up-only). Rollback options:

- **Disable the feature:** revoke the grants
  (`agent_timer_provision.py --revoke --all-owner-conversations`, or `DELETE
  .../agent-timer-grant`). The routes then refuse everything. Agent-created
  timers stay ordinary timers the owner can disable.
- **Code rollback below 79:** restore the train's pre-deploy database backup.
  Timers and audit rows written since then are lost. Do not drop the tables
  by hand on a live database.
