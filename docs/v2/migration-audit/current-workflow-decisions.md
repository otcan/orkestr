# Current private workflow decision inventory

The private decision table is maintained outside the public repository. It now
contains nine workflow groups, each with actual recorded-use evidence or explicit
unresolved status, lane owner, implementation disposition, acceptance and concrete
questions. It combines existing census receipts with new independent observations;
it does not assert a coherent cross-authority cut or full-release readiness.

Executed read-only authorities:

| Projection | Source authority / interpretation |
|---|---|
| Thread binding flags, runtime/repository/worktree presence and update windows | `threads.js::createThread`, `reply-delivery-intent.js::whatsappReplyDeliveryBindingEligible`; persisted state, not effective mute policy or process health |
| Recorded WA/role/timestamp/attachment aggregates | `thread-message-schema.js::ensureThreadMessageSchema`, `thread-message-registry.js::messageColumns`, `threads.js` attachment publication; bounded prefix of at most 10,000 storage rows, not latest history or complete totals |
| Timer structure and fixed run/error/next-run timestamp buckets | `timers.js::markDueTimersPass` and manual enqueue path; lastRunAt records enqueue, not completion |
| Runtime start/heartbeat/end timestamp buckets | `runtime-leases.js` lease construction/read/write; persisted unended heartbeat, not live provider execution |
| Desktop acquisition/heartbeat/expiry/release timestamp buckets | `desktop-lease-store.js::normalizeLease`, `desktop-leases.js::publicDesktopLease`; timestamp evidence only, without inferred effective fencing/staleness policy |
| Personal-agent memory row count | `personal-agent-memory-migration.js` specific table; no content, consent or external-memory inference |

The deployed source paths/symbols were checked against current deployed code;
private receipts pin source hashes and selected current service metadata. Only
named non-secret selectors were extracted from the current service process.
No complete environment was emitted. No helper initializer, list migration,
connector refresh, external call, profile, token or credential file was used.

`v2/migration/workflow_activity.py` uses explicit fixed paths/fields and count
expressions. SQLite uses mode=ro, query_only, trusted_schema off, pinned read
transaction, schema/table checks, qualified columns, binary enum comparison,
column/function authorizer and an eight-second query progress bound. JSON and
raw database values remain inside SQLite. Registry readers use nofollow regular
single-link files, bounded size/rows, duplicate rejection and metadata-stability
checks; only fixed timestamp buckets leave the parser. These files are parsed
for structural metadata, not exported. No registry helper or stale-lease cleanup
is called.

A full-history message aggregate exceeded its query bound and is recorded as a
refusal in private evidence. The subsequent bounded prefix completed; its counts
are explicitly lower bounds and zero never establishes absence. It cannot prove
current activity merely because it was observed now.

Blocking questions and ownership remain explicit:

- Runtime/UI: effective WA mute/hold authority and observed-route parity, while
  retaining existing messaging holds and the personal skill-only exclusion.
- Runtime: owner-required timer and provider continuation workflows, scheduler
  completion and current runtime health beyond persisted heartbeats.
- Core/Migration: project/artifact scoped export, content hashes, ownership and
  attachment accessibility; configuration fields do not establish filesystem use.
- Isolation: effective browser lease fencing/health without profile transfer.
- Connector owners: inert mail/calendar capability/activity selector bypassing
  account-list credential migration; canonical OXRM aggregate without profiles.
- Personal-agent/Core: current authenticated capability and consent/retention
  scoped memory export; a specific table count is insufficient.

Each private row spells out synthetic acceptance and paused/inert migration
behavior. This completes a concrete decision-table checkpoint; unresolved usage
and missing acceptance remain release blockers. No live restore or sending.
