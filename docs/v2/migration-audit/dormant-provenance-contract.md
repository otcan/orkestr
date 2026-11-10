# Proposed dormant apply boundary for Core review

This is a dependency contract, not a registered API, schema or implemented store.
Core owns names, schema and authority enforcement. Migration owns canonical
planning and adaptation. Ordinary live intake remains excluded. Stable
conversation export is a separate read boundary and cannot satisfy dormant apply.

## Deterministic request and provenance

A request must bind one authenticated destination owner and source namespace to
one canonical validated manifest digest and mapping version. A batch key is the
SHA256 of canonical JSON containing those four values; it must not contain
credentials or substitute for authorization. Core must define canonical owner
and namespace representations before this key is usable across implementations.
The existing planner's source identity and content digest remain per-record
inputs; caller-selected IDs never grant access. Preserve explicit source kind,
source version and source identity privately as provenance, with target mapping,
content digest, disposition, reason codes and imported revision. Do not persist
source secrets, auth sessions, active route destinations or raw credentials.

Core must atomically reserve/validate batch identity and record outcomes, or
expose a resumable receipt whose incomplete state can never be reported complete.
Replaying a completed identical request returns the same durable outcome.
Reusing an identity with changed content records a conflict and retains the
original evidence. Quarantine remains sticky across batch retries and propagates
through explicit references and implicit thread ownership, including newly
introduced dependents. Source namespaces need explicit authority binding; two
owners must not deduplicate or read one another's provenance accidentally.

Allowed planner dispositions are HISTORY_ONLY, PAUSED and QUARANTINED. Unknown
kinds/state, missing scope/owner/lineage, unsupported retention and uncertain or
cancelled effects require explicit quarantine reasons, never guessed conversion.
Core must reject unsupported target mappings; the current conversation contract
alone does not establish mappings for legacy runs, timers, routes or approvals.

## Inert transaction and receipt

Apply must never call intake, create outbox delivery, schedule timers, consume
approvals, activate routes, start runs or dispatch provider effects. Operational
records, if supported by an explicit Core mapping, begin PAUSED and require a
separate future owner-authorized activation. No activation is part of migration.
Quarantined material must not enter executable projections. No credential or
session restoration is part of this boundary.

A private receipt must distinguish complete, incomplete and refused outcomes and
bind owner, batch key, manifest/mapping version, per-record digest/disposition,
resulting target revision and durable provenance revision. A receipt must not
claim a multi-authority cut from independent per-store observations. Counts or
capability status cannot be used as source records or completeness evidence.

## Reconciliation, delta and rollback

Reconciliation compares recorded source identity/digest and target revision;
missing or conflicting evidence yields a hold. Before rollback, export the
batch's dormant projections plus subsequent V2-only deltas under an explicit
consistent cut. Rollback conditionally deactivates only unchanged, batch-owned
projections at their recorded revisions. Changed owners, newer revisions,
external/shared dependents or uncertain effects refuse deactivation and produce
fixed hold reasons. Never restore an entire pre-import database, broad-delete
mapped IDs or cascade into V2-only writes. Preserve source legacy data,
quarantine/conflict evidence and rollback provenance on every path. Restore may
only target a fresh inactive destination; installation recovery remains separate.

## Exact implementation dependency

Core should return its accepted request/receipt representations, transaction or
resume semantics, supported dormant record mappings, revision comparison and
conditional deactivation/export ports. Migration can then implement the adapter
and replay/conflict/rollback scenarios in dormant-rollback-edge.md. None of these
ports is implied by the existing IntakeStore trait. Tests against a real dormant
store are unexecuted until those ports exist. No Core source was changed here.
