# Calendar timers, silent runs, pauses and event triggers

Status: implemented on `v2/rust-rewrite` (migration `0063`). Builds on the
per-thread timer moves in [thread-timers.md](thread-timers.md): calendar timers
are ordinary durable timers (same owner grant, Stop fence, claim and window
queue); only the schedule, a small policy and the handling of results are new.

## Schedule kinds

`dormant_timers.schedule_json` gains two kinds next to `once`, `interval`,
`utc_clock` and `zoned_clock`:

- **calendar** `["calendar", zone, weekdays, start_minute, end_minute, every_hours, minutes]`
  An RRULE-like rule in an IANA zone. `weekdays` is 1 (Mon) to 7 (Sun), empty
  means every day. A run is inside the window when
  `start_minute <= local minute of day <= end_minute` (both ends inclusive).
  `every_hours` counts from the window's first hour; `minutes` are the offsets.
  - "hourly at :00, Mon-Fri, 08:00-19:00 Europe/Berlin" is
    `weekdays [1..5], start 480, end 1140, every 1, minutes [0]` (12 runs/day).
  - "hourly at :37, 09:00-23:00 Europe/Istanbul" is
    `weekdays [], start 540, end 1380, minutes [37]` (09:37 to 22:37; 23:37 is
    outside the window).
  Rules come from the tz database bundled into the binary. A local time skipped
  by a forward DST change runs after the gap, a repeated local time runs once,
  and occurrences are always computed strictly after the previous claim, so
  downtime coalesces to one catch-up run. Plain-words rendering
  (`CalendarRule::describe`) is shared by the server and the UI.
- **event** `["event"]`: never due by the clock (next due is the schedule
  horizon). It runs only on trigger events.

## Policy (`timer_policies`, one row per timer)

Edited through `PUT /api/v2/timers/{ns}/policy` (optimistic `expected_revision`);
never changes the timer's revision or generation and grants no authority.

| Field | Meaning |
| --- | --- |
| `silent_mode` | `off` or `unless_changed`. |
| `pause_until_ms` | No run before this instant; resume = `null`. `4102444800000` is "until resumed". |
| `skip_dates` | `YYYY-MM-DD` local dates (the rule's zone) that never run, for example holidays. |
| `digest` | `{timezone, minutes[]}`: local times at which one digest message is sent. |
| `trigger` | `{sources: [message,email,other], min_interval_s}`: runs on inbound events. |

Pause and skip dates move the *next due time* to the first occurrence at or
after the pause end that is not on a skip date (no catch-up burst), and also
hold back the scheduler (the due-candidate query excludes paused timers; the
admission transaction refuses a paused or skipped occurrence). A conversation
pause (`POST /api/v2/conversations/{id}/timer-pause`) applies the same rule to
all timers of the chat; per-timer pause is `POST /api/v2/timers/{ns}/pause`.

## Silent unless changed

The delivery adapter reports every timer run's final answer to
`POST /api/v2/conversations/{id}/timer-outcomes {claim_id, text}` before sending
anything. The server answers `deliver: true|false` and records the outcome
(`timer_outcomes`, idempotent per claim):

- exact `NO_REPLY` is always silent (as for every conversation);
- with `silent_mode: unless_changed`, a first line of `NO_NEWS` (also `NO NEWS`,
  `[no news]`, optionally followed by `: summary`) is silent, and a first line of
  `LOW_SIGNAL: summary` is held for the digest (delivered normally when the
  timer has no digest). A marker later in the body never hides real news.

The summary of silent and low-signal runs feeds the digest. The timer list shows
the last result and the number of silent runs since the last delivered result.

## Digest

When `digest.minutes` are configured, the supervisor creates one `timer_digests`
row at each local slot that has collected runs (nothing is created for an empty
slot, and a slot never produces two digests). The adapter picks pending digests
up with `GET /api/v2/conversations/{id}/timer-digests`, exports each as an
ordinary reply (a pseudo timer input answered by the digest text) and
acknowledges it with `POST .../timer-digests/{digest}/delivered`. Digests of
conversations without the adapter stay pending and are listed (recent five) in
the timer list response.

## Event triggers

`POST /api/v2/conversations/{id}/timer-triggers {source, event_key}` records a
durable event (`timer_trigger_events`, idempotent by `event_key`) for every
enabled timer of the chat whose policy listens to `source`. The supervisor
admits one run per timer with pending events, under the same grant and fences
as a clock run: events during a pause or on a skip date are dropped, bursts
coalesce into one run, and `min_interval_s` spaces runs (events wait, they are
not lost). The run's instruction gets a trailing `[Trigger: new inbound ...]`
line. The WhatsApp adapter reports each inbound message (`source: message`,
event key = the public message id). Gmail push and Instagram hooks use the same
endpoint with `source: email` / `other`; wiring those producers is separate.

## Creating and editing

`POST /api/v2/timers/calendar` creates a dormant calendar or event timer mapped
to a conversation with its policy and, when `text` (the instruction) is given,
enables it (durable owner grant). `POST /api/v2/timers/{ns}/schedule` edits the
rule of a natively created timer (not an imported V1 one) and replans it.
`POST /api/v2/timers/calendar/preview` returns the next runs of a rule.

## Deployment

- Server: migration `0063`; no new configuration. Restart with the existing
  `ORKESTR_V2_TIMER_CONFIG` supervisor.
- Adapter (`v2/compat/v1_runtime`): redeploy from the same commit to get silent
  runs, digests and message triggers. An adapter without the new routes keeps
  the old behaviour; a server without them is tolerated by the new adapter.
- Rollback: the new tables are additive. An older binary must not open a schema
  63 database (same rule as every migration); disable calendar timers and
  restore the pre-deploy rollback directory instead.
