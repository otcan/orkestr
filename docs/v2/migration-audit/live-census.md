# Live count-only edge: review candidate

`v2/migration/live_census.py::count_live(path, family=...)` supports the fixed
`threads` and `jobs` table families from `census.py::TABLES`. This increment
implements and tests the edge; production counts remain unexecuted pending
independent review of this exact source. No secret/config file, registry JSON,
message body, identifier, route content, profile or database row was read during
source-path discovery.

## Connection and query contract

The caller supplies the exact previously reviewed database path and family.
No automatic discovery, store initializer, fallback or environment loading runs
inside the adapter. Existing regular files without symlink ancestors are
required. Paths are URI encoded; SQLite opens `mode=ro`, never `immutable=1`.
Extension loading is disabled, `trusted_schema=OFF` and `query_only=ON` are set
before the authorizer is installed. A read transaction then pins the schema and
counts until close. Errors abort the report and close the connection. Report
consumers must redact raw SQLite exceptions, which may contain private details.

Only fixed ordinary table names are counted. `PRAGMA main.table_list` supplies
object types; absent, view, virtual and shadow objects never become table
counts. The authorizer permits that metadata pragma, SELECT, count(), empty
column READ events on allowlisted main tables, and BEGIN/ROLLBACK only. SQLite
can report the database argument as null for count(*) READ events, so null is
also accepted; ATTACH and temp/schema writes are denied. Nonempty column READs
are denied, including count(column). SQL is internal and fixed; callers cannot
supply a predicate, field, table name or expression.

Normal SQLite WAL/SHM coordination can occur with `mode=ro`; this is not a
promise that SQLite performs no lock/sidecar bookkeeping. The adapter issues no
source DDL/DML, migration, journal-mode change, checkpoint or backup. No
credential-containing whole-file snapshot is created. Concurrent writers
continue normally in WAL mode; a short read transaction can delay checkpoint
reclamation. Connection lock timeout is two seconds; this is not a query runtime
limit. Use only the reviewed local state stores, not hostile/untrusted files.

Reports contain table counts/status and a start/end UTC interval, no source path
or record contents. Per-store transaction coherence does not establish
cross-store consistency or a common cut watermark. Persisted record counts
cannot distinguish actual workflow usage, worker lineage or operational state.
Other workflow stores retain explicit unknown coverage; missing tables are
`absent` with null count, not zero. No import, activation or dispatch is provided.

## Source location review

Reviewed source symbols:

- `packages/storage/src/paths.js::appHome/dataPaths`: configured data home and
  fixed `threads.sqlite` basename.
- `packages/storage/src/thread-registry.js::openThreadDatabase/ensureSchema`:
  schema includes `orkestr_threads`; initializer is deliberately bypassed.
- `packages/core/src/agent-job-store.js::agentJobDbPath/schema`: explicit
  `ORKESTR_AGENT_JOBS_DB` override, otherwise `agent-jobs.sqlite` in data home.
  This helper calls directory initialization and is not invoked.
- `packages/core/src/agent-job-entities-migration.js::statements`: optional
  personal-agent project/task tables; missing feature tables stay unknown.

The generic deployed launcher and deployed copies of these source definitions
were inspected. Only the specific non-secret storage/source selectors were
examined; no environment file was opened or sourced. The configured data-home
selector and default job-store path formula identify two candidate stores.
The deployed entity migration also defines `personal_agent_task_transitions`,
which is outside the pinned allowlist and remains an explicit coverage gap.
Launcher-loaded environment overrides still require confirmation from an
approved runtime metadata projection before claiming service-authoritative
coverage. Machine paths and actual census results belong only in the approved
private report directory, mode 0700, with exclusive mode-0600 report files.
They must not be committed, printed in CI or included in public fixtures.

## Validation and next step

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s v2/migration/tests -q
```

48 synthetic tests pass, including nine live-edge tests: a WAL writer commits
between counts, the initial transaction retains both old counts, and a new
transaction sees the commit. Refusal checks cover fields/count(column), writes,
ATTACH, schema access, extension calls, missing/corrupt files, symlinks and
URI metacharacters. A guard-removal test independently confirms mode=ro still
rejects writes. Views/virtual tables and absent tables have explicit statuses.

Next: independent source review of this adapter, then run only the reviewed
thread/job candidate stores and write aggregate reports in the authorized
private directory. Confirm any service-side job-path override through safe
metadata first. Production counting, private report persistence and CI are
unexecuted in this increment. Cross-store export/import and release readiness
remain outside this edge's claims.
