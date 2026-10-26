# Per-thread timer moves and single-owner handoff

Status: implemented for the parallel run (workstream B2). Moves the timers of
one V1 thread into the V2 conversation that thread was moved to, hands each
timer's ownership to V2 in one operator step, runs due timers as Deep turns in
that conversation, and relays timer replies to WhatsApp through the multi-chat
adapter like ordinary replies. Handback reverses it. Every writing command
needs `--apply`; nothing runs from CI or by default.

## One timer, one owner

| State | V1 | V2 | Who fires |
| --- | --- | --- | --- |
| Imported | unchanged | `paused` (dormant, original V1 enablement recorded) | V1 |
| Handed off | `ownedBy: "v2"`, disabled, refuses run/edit/delete | `enabled`, durable owner grant | V2 |
| Handed back | fence lifted, original enablement restored, next run from now | `disabled`, outstanding occurrence held | V1 |

Handoff is **fence first**: the V1 `ownedBy: "v2"` marker is written before the
V2 enable. A definite V2 refusal immediately hands the timer back to V1. An
unknown V2 outcome (transport failure) leaves the timer with *no* owner, which
is safe; re-running the same command finishes the move, because every step is
idempotent by deterministic key (`v2:<namespace>` for V1,
`handoff:<namespace>:<revision>` for V2). Handback disables in V2 first, then
lifts the V1 fence. At no point can both systems fire the same timer.

The V1 fence (`packages/core/src/timer-ownership.js`) is serialized with the V1
due pass. While a timer is owned by V2, V1 never enqueues it (even if its stored
file says enabled), and `run`, update, pause/resume and delete are refused with
`409 timer_owned_by_v2`. `status` reports the owner of every timer and fails
`single_owner` if both are active.

## V2 behaviour

- **Schedules.** V1 `daily`/`weekly` with an IANA zone become `zoned_clock`
  (`timezone`, `weekday` 1=Mon..7=Sun, `minute_of_day`). Rules come from the tz
  database bundled into the binary (`jiff`), not host tzdata. A local time
  skipped by a forward DST change runs after the gap (02:30 becomes 03:30); a
  repeated local time runs once. V1 weekly timers keep the weekday of their
  stored next run. `interval` and `once` map exactly. Timers without a zone,
  with an unknown zone or an unusable cadence import as dormant with the
  reason (`missing_timezone`, `unsupported_timezone`, `ambiguous_cadence`) and
  are never enabled; `--default-timezone` supplies the zone V1 implicitly used
  (host local time).
- **Mapping.** `POST /api/v2/timers/import` records the target conversation,
  label and V1 thread immutably (`dormant_timer_targets`, migration `0049`). An
  enable of a mapped timer must target that conversation.
- **Execution.** The timer controller scans only timers that are due by the
  Store clock. One transaction claims the occurrence, admits the owner
  instruction as ordinary input (`client_message_id` `timer:<claim>`) and, when
  the server runs beta execution windows, queues its Deep window intent
  (`timer-window:<event>`) in the durable window queue, then wakes the
  dispatcher. Overlapping ticks admit one occurrence (unique claim per
  generation and due time, `BEGIN IMMEDIATE`). Missed runs coalesce: the next
  occurrence is computed from the claim time, so downtime produces exactly one
  catch-up turn. Paused, disabled, stopped and rolled-back timers are never
  scanned; disabling holds an outstanding occurrence so it never executes. A due
  occurrence that cannot be admitted (Stop boundary changed, conversation
  removed, window queue full) backs off 5 s doubling to 15 min per timer.
- **Failed open.** When an occurrence's window fails to open before anything
  of it ran, Core closes the window as `failed` and queues the intent once
  more under its own key (`timer-window:<event>:retry1`). The manager admits
  the same input again only because its earlier window retired as a failed
  open with no run. A second failed open leaves the input released. A window
  the manager never admitted (no acknowledgement, no credential) is closed by
  Core alone once the manager reports an earlier retired generation for the
  conversation; the manager accepts the successor across that generation gap.
- **Deep turn.** Dispatch re-authenticates with the owner's current browser
  session, exactly like queued owner input; the turn's results await
  acceptance as usual. `ORKESTR_V2_TIMER_CONFIG` may now be combined with
  `ORKESTR_V2_BETA_CONFIG`.

## WhatsApp delivery

For a conversation bound to the multi-chat adapter
(`v2/compat/v1_runtime`), the adapter discovers timer occurrences through
`GET /api/v2/conversations/{id}/timer-inputs`, adopts each into its ledger and
drives it like an intake: it waits for the server-queued window (or opens one
itself if the queue row was withdrawn), accepts Fast and Deep, and exports the
canonical Deep reply. The export is preceded by a user row
`{source: "orkestr-v2-timer", origin: "timer", publicMessageId: "v2timer-<id>"}`.
V1 materializes that row once as a local parent message (no execution, no
WhatsApp send), so the reply is imported with a parent, mirrored through the
ordinary outbox and acknowledged (`delivered`), which settles it in the
adapter. Unlike V1 relay timer replies, it never depends on
`remoteMirrorOrphanReplies`. The first discovery scan only records the current
position: occurrences admitted before the adapter supported timers are not
replayed. Held occurrences finish without any export.

## Operator commands

Private output directories (`umask 077`), a private credentials file
`{"username": …, "password": …}` (mode 0600), and the reviewed `orkestr` V1 CLI
on `PATH` (or `--v1-cli`). Reports contain identifiers and states only.

```sh
M=v2/migration/thread_timers.py
OUT=/var/tmp/orkestr-timers/$(date -u +%Y%m%dT%H%M%SZ); mkdir -p -m 700 "$OUT"
V2="--v2-url http://127.0.0.1:19822 --credentials-file CREDS"

# 1. Export the thread's V1 timers (read-only) into a private bundle.
python3 -I -B $M v1-export --thread THREAD_ID --source-instance orkestr-v1-production \
  --default-timezone Europe/Berlin --out "$OUT/timers.json"

# 2. Import them paused into the thread's V2 conversation (preview, then apply).
python3 -I -B $M v2-import --bundle "$OUT/timers.json" --thread THREAD_ID --conversation UUID $V2
python3 -I -B $M v2-import --bundle "$OUT/timers.json" --thread THREAD_ID --conversation UUID $V2 --apply

# 3. Hand off (only timers enabled in V1; --timer ID to pick). A timer disabled
#    in V1 is never enabled in V2, even with --timer or --include-disabled; it is
#    reported under "skipped" (reason source_disabled) and named on stderr.
#    Only --force-enable-disabled hands such a timer off and enables it.
python3 -I -B $M handoff --bundle "$OUT/timers.json" --thread THREAD_ID --conversation UUID $V2
python3 -I -B $M handoff --bundle "$OUT/timers.json" --thread THREAD_ID --conversation UUID $V2 --apply
python3 -I -B $M status  --bundle "$OUT/timers.json" --thread THREAD_ID --conversation UUID $V2

# Rollback: hand back to V1 (--keep-disabled to leave it off in V1).
python3 -I -B $M handback --bundle "$OUT/timers.json" --thread THREAD_ID $V2 --apply
```

V1 commands used by the CLI (also usable directly):
`orkestr timers handoff <timer-id> --handoff-id v2:<namespace> --json` and
`orkestr timers handback <timer-id> --handoff-id v2:<namespace> [--keep-disabled] --json`.

The V2 instruction is the V1 timer prompt. Many V1 prompts only point at a V1
prompt file; use `--inline-prompt-file` when the V2 Deep workspace cannot read
that path. The bundle holds those private instructions: keep it 0600 and
delete it after the move.

## Deployment

- V2: deploy the server with migration `0049` and set
  `ORKESTR_V2_TIMER_CONFIG` (private `{"schema_version":1,"machine_token_file":…}`,
  machine token from `POST /api/v2/session`, renewed by the service hourly)
  beside the beta configuration. In a selected-service plan, set
  `timer_config` to the private config path; the packager passes it to the
  server as `ORKESTR_V2_TIMER_CONFIG` and never opens it. Deploy the multi-chat adapter from the same
  commit before handing off a WhatsApp thread's timers.
- V1: the ownership fence and timer-parent materialization ship through the
  release train; hand off nothing until that V1 release is live.

## Limits

- A Stop pressed in the conversation fences its timers (existing safety rule);
  they show `controller_hold: durable_owner_enable_required` and need a fresh
  owner enable (re-run handoff after handback, or enable through the timer API).
- Dispatch needs a current owner browser session (the adapter keeps one alive
  for WhatsApp conversations). Web-only conversations start their queued turn
  on the owner's next authenticated request after a restart.
- V1 `requiredDesktop`/`requiredConnector` preconditions are recorded in the
  bundle but not enforced by V2.
