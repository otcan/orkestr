# Local journal contract v1

Status: first implementation boundary, not a public authenticated API. Tracking: #72,
V2-003 and the graph/journal portion of V2-013. Baseline: `fffa3d8c`.

## Scope and authority

The first slice is a trusted local library with no network listener, provider,
credentials, automatic path discovery or effect dispatcher. The caller supplies a
fresh synthetic database path. Never open a 1.x store with this library.
`ORKESTR_HOME` and provider configuration are not inputs. Domain IDs are opaque,
case-sensitive strings, not phone numbers or provider session IDs. Nonblank entity,
event and worker IDs are required. Typed scope/actor IDs, supervisor admissions,
leases and approvals remain prerequisites for an externally callable service.
Do not expose append to a model or treat a valid event as permission to execute.

## Wire format and compatibility

`JournalRecord` is strict JSON with `schema_version: 1` and `envelope` containing
`event_id` and an externally tagged `event`. Unknown versions, event variants and
fields fail closed. Example (synthetic IDs only):

```json
{"schema_version":1,"envelope":{"event_id":"event-1","event":{"ConversationCreated":{"id":"home","kind":"Home","parent_id":null}}}}
```

The journal assigns an increasing SQLite integer sequence, separate from event
identity. Replay follows that sequence, never timestamps or hash-map order. A
retry with the same event ID and structurally identical record returns the original
sequence without another event. Reusing an ID with changed content is a conflict.
A rejected event leaves no row, cursor change or projection change. Ordering is
instance-local; this is not a distributed clock or a remote exactly-once promise.
Unknown newer database versions must be refused before schema writes. Schema v1
uses a recognizable application ID; unrelated SQLite databases must be refused.

| Event | Required fields | Transition / rejection |
|---|---|---|
| ConversationCreated | id, kind, parent_id | Unique ID; parent already exists if set. Immutable parent edges make cycles impossible. Kinds: Home, Project, Topic, Worker. These preserve graph history, not the final UI navigation. |
| TaskQueued | id, conversation_id | Unique task; conversation exists; state Queued. |
| TaskStarted | task_id, worker_id | Queued → Running, records worker. Does not prove worker liveness or authorization. |
| TaskCompleted | task_id, worker_id, result_ref | Running → Completed only for recorded worker; result reference nonblank. Does not validate acceptance evidence yet. |
| TaskCancelled | task_id | Queued/Running → Cancelled. No terminal restart or false rollback of an external effect. |

`result_ref` is an opaque reference to separately removable result content, not
prose or an embedded message. No raw message, summary, credential, phone number,
model context or personal-memory payload belongs in the immutable journal. IDs
and references still require retention/export policy before real-data use. This
slice stores no payloads, so it does not claim deletion/memory functionality.
The pre-persistence starter's `summary` field is replaced before the first durable
schema; no legacy database exists to migrate from that in-memory prototype.

## Storage and replay

SQLx + SQLite; WAL, synchronous FULL, foreign keys enabled, bounded busy timeout.
A writer obtains `BEGIN IMMEDIATE` before reading authoritative history. Validate
and apply using the pure reducer, insert the event and materialize conversation
and task projections plus cursor in the SAME transaction. Commit before success.
No network/process await or external side effect occurs in that transaction.
Concurrent handles must serialize at SQLite, not rely on an in-memory mutex alone.

For this deliberately small slice, rebuild from the complete journal when writing
or explicitly replaying. This is O(history) and is not a scalability claim. A later
incremental projector requires equivalent corruption/recovery tests. Projection
rebuild is atomic: readers see old or new complete state. Journal corruption,
unsupported versions or impossible transitions fail replay without replacing the
last projection. A replay never invokes a tool, starts a worker or sends a message.
A recorded Running state is historical; future supervisor recovery must reconcile
leases and effects rather than assume a live process or automatically rerun it.

## Required tests

Persist/reopen equivalence; original-sequence retry after reopen; conflicting ID
rejection; concurrent handles, both same and competing IDs; invalid parent/task/
worker/terminal transitions leave journal and projection unchanged; malformed and
future-version records refuse replay; unknown database version/unrelated database
refused without mutation; projection deletion/rebuild; process killed before commit
leaves no event/projection, killed after commit retains both; retry after lost
acknowledgement is a duplicate; replay produces no external effects by construction.

## Extension boundaries

Versioned project/default-conversation, message+inbox, session/run/lease, actor,
approval and effect contracts land through a new reviewed additive schema change.
No unknown enum fallback. Never infer owner identity from a worker or provider ID.
UI may consume a read-only projection DTO; it cannot import SQLx or privileged
runtime modules. Copy-only import first validates snapshot structure and reports
unmapped fields; timers, runs and routes remain dormant, credentials excluded.
