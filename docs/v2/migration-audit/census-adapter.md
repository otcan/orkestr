# Count-only snapshot adapter

`v2/migration/census.py::count_snapshot` is a bounded metadata adapter, not a
live inventory command or export implementation. Supply a reviewed, standalone,
consistent SQLite metadata snapshot, its SHA256 and a nonempty external
consistency receipt. No production snapshot has been read or counted here.
Receipt presence is a prerequisite, not verification of the exporter's claim.
The caller must independently validate it before invocation.

The adapter reads at most 64 MiB, verifies the digest, and deserializes into an
in-memory SQLite connection. It never opens the source with SQLite, avoiding
live WAL/shared-memory bookkeeping. Sidecars and symlink inputs are rejected.
Only fixed table names and `count(*)` are queried; an authorizer denies column
reads and other operations during counting. Views and virtual tables are not
executed. Missing tables produce `absent` with a null count; existing empty
tables produce zero. Neither implies absence of a workflow in another store.
It does not initialize schema, traverse history, dispatch effects, or import.

Source references at the pinned audit baseline
`76f9c6cd91e094329ae5c29c7e95f301366ed02a`:

| Family | Fixed tables | Source |
|---|---|---|
| threads | orkestr_threads | `packages/storage/src/thread-registry.js::ensureSchema` |
| jobs | job_specs, jobs, runs, attempts, checkpoints, effects, approvals, notifications, trigger_audit, schedule_state | `packages/core/src/agent-job-store.js::schema` |
| jobs | personal_agent_projects, personal_agent_tasks | `packages/core/src/agent-job-entities-migration.js::statements` |

Counts are partial coverage of persisted records, not distinct used workflow
kinds, completion, active state, or a consistent cross-store watermark. Thread
worker kinds are embedded in JSON and are deliberately not selected. Registry
JSON timers/connector pushes, message stores, setup usage, resource stores,
connector receipts, memory and artifacts remain explicit coverage gaps. Counts
and snapshot digests can themselves be private: keep actual input, receipt and
results in the private operator overlay, never public fixtures or CI logs.

Do not point this adapter at live databases, credentials, sessions, profiles,
route stores or an unreviewed full recovery backup. A database containing such
rows remains excluded even though queries would select counts only. Hashing and
deserialization read the supplied bytes; this is not a privacy scanner or a
sandbox for untrusted SQLite files. Snapshot creation and source authorization
are separate responsibilities. Recovery backups with auth/session rows are not
canonical migration snapshots.

Next dependency for Coordinator/Core/Installation: supply a reviewed metadata
snapshot edge that produces fixed-table metadata-only SQLite with coherent
source/schema version, cut watermark and exporter receipt, excluding auth,
session and route content; identify its private overlay output destination.
Alternatively provide an authenticated equivalent count projection that bypasses
store initializers. No live reads are attempted until that edge is reviewed.
This is needed to establish actual workflow coverage; consistent history
export/import, inert provenance storage and V2-only delta restore remain held.
Main messaging holds and personal skill-only exclusions remain unchanged.

Validation (synthetic only):

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s v2/migration/tests -v
```

Five census tests cover counts/absence, no payload output or filesystem changes,
digest/receipt/family rejection, sidecar rejection, view exclusion and symlinks.
The full suite contains 39 tests. Actual workflow census, exporter receipt
verification, private overlay writing and production integration are unexecuted.
