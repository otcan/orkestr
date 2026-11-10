# Provider and trigger-class aggregate review candidate

The exact reviewed run-state projection has now been executed by root against
the selector-confirmed job store. Migration read the private receipt and retained
its values privately. Run-state observations close the execution-evidence gap
for that projection only; they do not establish current execution, all workflows
or cross-store consistency. No actual values appear in these artifacts.

The next executable candidate is
`v2/migration/workflow_projection.py::workflow_class_projection(path)`.
It takes an explicitly reviewed job-store path, with no runtime discovery,
initializer, registry/profile access or dispatch. The existing mode=ro,
query_only/trusted_schema guards and pinned transaction are reused. Both
aggregates share one per-store snapshot. No production invocation of this new
candidate has occurred in this increment.

## Source-validated allowlist

| Projection | Table and only permitted data column | Fixed buckets | Source authority |
|---|---|---|---|
| attempt_provider | attempts.provider | codex, claude-code, openai-compatible, simulated | `packages/core/src/agent-job-spec.js::AGENT_JOB_PROVIDERS/AGENT_JOB_TEST_PROVIDERS`; `agent-job-runner.js::driveLeased`; `agent-job-store.js::insertAttemptSync` |
| trigger_audit_class | trigger_audit.trigger_type | schedule, webhook, api, whatsapp | `packages/core/src/agent-job-spec.js::AGENT_JOB_TRIGGER_TYPES`; `agent-job-store.js::recordTriggerAudit`; callers in `agent-job-scheduler.js`, `agent-job-hooks-http.js`, `agent-job-admission.js` |

These enum declarations were checked in the worker source and deployed generic
source. No credential/config file was opened. `simulated` is explicitly a test
provider, not evidence of a production connector. Future enum additions require
an explicit mapping refresh. Case variants, arbitrary strings and null values
contribute only to unknown; no normalization or inferred conversion occurs.

The fixed SQL for each row above is:

```sql
SELECT count(*),
       coalesce(sum(CASE WHEN source."COLUMN" COLLATE BINARY = ? THEN 1 ELSE 0 END), 0),
       ...
FROM main."TABLE" AS source
```

COLUMN/TABLE are internal constants from the two-row allowlist, never caller
arguments. There is exactly one CASE aggregate per fixed bucket, with its
literal bound as a parameter. Unknown = total minus known bucket counts.
There is no GROUP BY, raw value selection, join, filter or result body read.

Each query has its own narrowed authorizer: empty-column count reads and its
single table/column are permitted, along with SELECT and count/sum/coalesce.
Other tables, columns, functions, writes, ATTACH and metadata pragmas are denied
while the query runs. Views/virtual/shadow tables are unavailable; a failure
aborts the entire report. Raw SQLite errors must remain private. As with the
state projection, the authorizer is defense around fixed SQL, not a privacy
boundary for arbitrary SQL on an exposed connection; no connection is exposed
by the public function.

## Meaning and remaining gaps

Provider counts measure attempt records, including repeated/fallback attempts,
not distinct jobs, threads, users or connected accounts. They do not prove a
provider is currently connected or permitted. Trigger-audit records include
refusals/skips and are not a complete journal of successful triggers. A class
count does not prove a route is enabled or an effect occurred. Zero counts
cannot establish unused workflow classes in other authorities.

Thread role/worker lineage still requires a source-owned aggregate projection:
those fields are embedded in thread JSON, which remains excluded here. Timers,
automations, setups, connector status, resources and memory need their own
reviewed authorities. Do not fall back to whole-file JSON, credentials, session
or profile reads. Dormant apply/export/provenance/revision ports remain a
separate Core dependency; these aggregate results cannot drive import/rollback.

Review request: independently inspect this exact public function and its SQL
allowlist before invoking against the root-confirmed job-store selector. Use a
bounded process and save the aggregate receipt only in the approved private
0700 directory with mode0600. No production counts, IDs or paths belong in OSS.

Validation:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s v2/migration/tests -q
```

58/58 synthetic tests pass. Six new tests cover known/unknown fixed buckets,
case variants, views/virtuals, zero-count semantics, forbidden data/operations,
and a concurrent WAL commit invisible to both aggregates until a later
transaction. Live provider/trigger projection and CI are unexecuted.


## Independent count-integrity correction

Independent source review found two schema-drift cases in the original provider/
trigger candidate: an unqualified double-quoted missing column could become a
SQLite string literal, and a NOCASE column could fold unknown uppercase values
into known buckets. The corrected query qualifies every expected column with
its fixed source alias and explicitly selects COLLATE BINARY. A missing expected
column now aborts the complete report, including failure of the second query;
no partial result is returned. This does not widen the authorizer.

Both cases now have synthetic regressions for provider and trigger columns.
Related state/thread projections also use qualified data columns and explicit
binary enum comparisons, with matching missing-column and NOCASE controls.
The complete suite passes 73/73 tests. No live provider/trigger projection was
run; the corrected exact commit still requires independent review. Earlier
review of the original predicate is superseded for count integrity.
