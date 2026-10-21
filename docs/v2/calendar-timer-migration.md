# Migrating V1-style timers into one calendar timer

Status: tool only; nothing here runs by itself. The calendar timer model is in
[calendar-timers.md](calendar-timers.md) (server migration `0062` and the
`POST /api/v2/timers/calendar` route must be deployed before `calendar-apply`).

`v2/migration/thread_timers.py calendar-*` turns a group of handed-off or V1
timers into ONE calendar timer and keeps the old ones off for rollback. A recipe
(`v2/migration/recipes/*.json`) names the timers it replaces, the controllers it
retires, the rule (derived from the timers when they sit on a regular hourly
ladder, or explicit), the silent mode and the digest.

```sh
M=v2/migration/thread_timers.py
# 1. Private bundle of the thread's V1 timers (read-only), as for handoff.
python3 -I -B $M v1-export --thread 157ea1bfc66836fd --source-instance orkestr-v1-production \
  --default-timezone Europe/Berlin --out "$OUT/timers.json"
# 2. Read-only plan: the rule in words, what is replaced, the plan digest.
python3 -I -B $M calendar-plan --bundle "$OUT/timers.json" --recipe v2/migration/recipes/jobs-triage.json \
  --conversation CONVERSATION --v2-url URL --credentials-file CREDS
# 3. Apply with the digest from the plan (it binds the rule, policy, instruction and timers).
python3 -I -B $M calendar-apply ... --confirm DIGEST
# 4. Rollback: disable the new timer first, then re-enable the old ones (or --to v1).
python3 -I -B $M calendar-rollback ... [--to v1]
python3 -I -B $M calendar-status ...      # flags a double owner
```

`calendar-plan` without `--v2-url` works offline from the bundle (and optionally
`--v1-timers-json`, a saved `orkestr timers list --json`).

## Order, idempotency and rollback

Apply is fence first, so old and new never run together: V1 timers still run by
V1 are fenced (`ownedBy: v2`); the calendar timer is created paused; the old V2
timers are disabled; only then the calendar timer is enabled with the unchanged
instruction. An interruption leaves zero owners, never two, and re-running the
same command finishes the move: every request key is deterministic, so a repeat
changes nothing. The new timer's namespace is derived from the source instance,
the recipe name and the thread.

The instruction is the V1 prompt, byte for byte (all replaced timers must carry
the same one, otherwise the tool stops). Send-approval rules that live in the
prompt or in the workspace's `AGENTS.md` (draft first, send guard) therefore
keep applying, and are not touched by this tool.

Old V2 timers stay disabled and V1 copies stay fenced or disabled, so rollback
is a state change: `calendar-rollback` disables the calendar timer first, then
re-enables the old V2 timers with their original instruction (`--to v2`, the
default) or hands them back to V1 (`--to v1`). V1 controllers stay disabled
either way; re-enable them in V1 only when going back to V1.

## The two prepared recipes

- **jobs** (`recipes/jobs-triage.json`, V1 thread `157ea1bfc66836fd`): twelve
  hourly triage timers become "Hourly at :00, Mon-Fri, 09:00-20:00
  Europe/Berlin, silent unless new", and the weekday-enable/weekend-disable
  controllers are retired. As of 2026-10-21 the twelve timers are already handed
  off and enabled in V2 (conversation `be924b61-...`, daily 09:00 to 20:00
  Berlin, every day, relying on the prompt's weekday guard, which stays). The
  window is the one the existing timers have; the owner brief said 08:00-19:00,
  so the plan must be reviewed: set `schedule.start` / `schedule.end` in the
  recipe to change it (the plan digest changes with it).
- **swingdanceizmir** (`recipes/swing-inbox.json`, V1 thread
  `89d8601a-679a-48a6-8c5f-df4426eab0c3`) is a V1 Claude thread and stays one.
  Its hourly inbox timer ("Hourly at :37, every day, 09:00-23:00
  Europe/Istanbul", silent, digest at 09:00) can be converted only after the
  thread has moved to V2 as a Claude conversation. Until then `calendar-plan`
  without `--conversation` prints the prepared definition as blocked
  (`thread_not_on_v2`) and `calendar-apply` refuses. The thread's other timers
  (8-hourly ads status, daily WhatsApp, two spent one-shots) are not part of it.
