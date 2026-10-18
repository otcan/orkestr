# Remaining workflow authority inventory

This source-review inventory distinguishes an unavailable **inert selector** from
an absent product feature. Absence of a table is not evidence of feature absence;
zero rows is not proof a workflow is unused. No new production read was performed
for this increment. Actual prior private receipts remain outside this repository.

| Authority | Inert selector / evidence | Coverage and remaining gap |
|---|---|---|
| Primary threads | Reviewed/executed fixed structural JSON aggregate | Persisted role/runtime/lifecycle/binding shape only; not active use/effective capabilities. |
| Job engine | Reviewed/executed fixed table/run-state/provider/trigger buckets | Independent engine metadata only; empty jobs do not imply unused timers/connectors. |
| Personal-agent capability | Source-reviewed authenticated GET plus strict capability_metadata adapter | Fixed enabled/storage-ready response is safe candidate; actual status observation unexecuted. No auth bypass or synthetic admin principal. |
| Personal-agent memory | New family personal_memory in census.TABLES, reusable count_live transaction | Exact SELECT count(*) FROM personal_agent_memories; source table name validated below. Independently reviewed and executed at exact 8be70df9; private receipt retained outside OSS. No content, category, consent, provenance or IDs read. Not external/main memory coverage. |
| Independent timer registry | No approved inert selector in reviewed list/doctor | Existing features are present. list calls ensureDataDirs and reads prompt-bearing JSON; doctor probes prompt files/loads threads. A bounded structural parser is authorized after exact source path/schema validation; implementation and review remain pending. |
| Gmail/calendar connections | Account GET explicitly excluded as mutation-bearing | Feature availability/usage unknown, not unavailable. Legacy credential migration can happen during list; safe metadata authority must bypass migration/token loading/refresh. |
| Effective binding capabilities | Thread binding-object shape only | Nested capabilities/active routes unknown; no binding registry or route reads. Need fixed authority-owned enabled-class counts. |
| Personal/external memory | Only the specific personal-agent table candidate above | Other memory authorities not established. Do not equate one job-store table with all memory. |
| Mail/calendar activity and OXRM | No reviewed inert aggregate selector identified | Usage unknown. No account, profile, message, external service or credential inspection. |

## Exact personal-memory count authority

`packages/core/src/personal-agent-memory-migration.js::tableName` defines
personal_agent_memories. Its schema contains content_json, provenance_json,
consented_by and other sensitive columns. The candidate reads **none** of them.
It reuses live_census.count_live(path, family='personal_memory'): URI mode=ro,
query_only ON, trusted_schema OFF, schema-pinned single read transaction,
allowlisted ordinary table, authorizer permitting count(*) empty-column access
only. Missing table returns absent/null; views/virtual tables unsupported/null;
only an ordinary table can yield a count. No initializer/migration is called.

Three new synthetic tests cover a table containing private marker data without
output leakage, column/count(column)/other-table refusals, missing table and a
view that is never evaluated. Existing concurrent-writer snapshot and refusal
tests continue to exercise the same unchanged transaction implementation.
Cross-store coherence and workflow activity remain explicitly unestablished.

## Minimal outstanding authority requests

An authorized personal-agent capability response can be validated directly; do
not retrieve/synthesize authentication here. Root independently reviewed and executed the memory-table count against its verified jobs authority; the receipt remains private. Do not call the migration initializer to make a
missing table appear. Timer/connector owners must supply fixed count projections
inside their respective authorities with malformed/unknown buckets and no raw
identities/prompts/paths. Main messaging holds and the personal skill-only
router/autostart exclusion remain intact. This completes the bounded **source
selector inventory**, not used-workflow parity or full-release acceptance.
