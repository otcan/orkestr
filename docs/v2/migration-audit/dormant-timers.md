# Dormant schedule adapter and requested Store boundary

`v2/migration/timer_schedule.py` implements a pure schedule projection, strict
validation, deterministic dormant import intent and explicit enable intent. It
performs no file reads, authentication, persistence, scheduler admission or
external dispatch. Enable is an intent, not proof of authorized/idempotent Store
enabling. The source store and its original data remain untouched.

Source baseline is the worker source tree at
`e88d236222ab5784a655abebd3f2c6e42bf9f545`:
`packages/core/src/timers.js`, `normalizeStoredTimer`, `createTimer`,
`normalizeTimerTimezone`, `parseClock`, `parseIntervalMs`, `nextRunAt`,
`nextZonedClockRunAt` and `markDueTimersPass`.

| Source normalized field | Export contract | Restriction |
| --- | --- | --- |
| id | sourceTimerId | Opaque bounded string; no UUID conversion |
| enabled | sourceEnabled | Explicit boolean provenance; target always PAUSED |
| cadence | schedule.cadence | once, interval, daily, weekly only |
| runAt | schedule.runAt | once: explicit zoned instant normalized UTC |
| every | schedule.everySeconds | interval: integer m/h/d, source zero clamps to one; adapter caps at 366 days |
| time, timezone | schedule.time, timezone | daily/weekly: explicit valid clock and zone |
| source snapshot namespace | sourceNamespace | Caller-supplied provenance; not cross-authority consistency |

The SHA256 covers canonical projected metadata only, including source identity,
enabled provenance and schedule. It does **not** attest excluded source data or
whole-registry consistency. Input must already be normalized; this module does
not call the mutation-bearing normalizer/initializer or invent missing fields.
The normalized projection is separate from a future Core binary receipt digest.

Weekly source behavior chooses today's local clock if still future, otherwise
seven days later. There is no weekday field. The adapter refuses legacy fallback
clock/interval values, unknown/terminal statuses, legacy objects, absent timezone,
and ambiguous/nonexistent DST wall times. These are review gaps, not conversions.
Overdue once timers require explicit rescheduling; import cannot cause catch-up.
Interval preview starts from the supplied fake clock, without restoring a last
execution. Source lastRunAt means enqueue, not completed external effects.

Prompts, promptFile, owner credentials, target routes, connector/browser bindings,
sessions and execution/error payloads are excluded. Consequently schedule parity
does not establish runnable workflow/prompt parity. Target work and capability
must be authorized separately. Main routing holds and personal skill exclusions
must not be relaxed by enabling a timer.

## Exact dependency requested from Core

No timer Store symbols/schema have been supplied or invented here. Core owns DTOs,
schema allocation and registration. The requested additive port must:

- Authenticate the current target owner inside the write transaction before any
  replay lookup. Import to a fresh target namespace with inert schedule/provenance
  only; no outbox, automatic timer activation or dispatch.
- Deduplicate exact source namespace/opaque identity/projected digest. Identical
  replay returns immutable original receipt; changed content conflicts. Validate
  an exact versioned shape, aggregate bounds and unique target identity.
- Explicit enable requires fresh current auth, target capability authorization,
  expected revision and bounded request key. Same semantic key replay returns the
  persisted original receipt; changed schedule/target/revision conflicts. The
  computed due time belongs in that receipt; retry wall-clock changes must not
  change semantic request identity. `previewDueAt` here is diagnostic only.
- Reject terminal/uncertain effects and overdue once timers; no catch-up. A fake
  clock drives Store acceptance. No provider or dispatcher is invoked by tests.
- Preserve provenance across disable/rollback, refuse revision conflicts and
  retain native target delta. Rollback semantics and scheduler admission remain
  Core decisions before implementation, not implied by the adapter.

Acceptance remaining: registered Store tests for current-auth revocation, exact
replay, changed-key conflict, stale revision, simultaneous enable, reopen and
transaction failure; independent fake-clock due-time oracle and proof no runnable
admission on import. Durable enable, rollback and scheduler integration are
**unexecuted** pending that port. Adapter tests do not substitute for them.

Executed lightweight checks: seven adapter tests cover projected exclusions,
weekly ordering, interval/once, overdue refusal, DST fold/gap, invalid legacy
states, digest tamper, deterministic intent and no input mutation. The synthetic
weekly fixture contains no operational identifiers.
