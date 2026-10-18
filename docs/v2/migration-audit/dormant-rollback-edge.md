# Dormant apply/export/rollback dependency

Counts and usage projections cannot become import input: they contain no source
identities, ownership, records, lineage or consistent cross-store cut. Existing
planner/bundle/ledger tools remain inert interchange tooling. No Core apply or
product rollback is implemented or claimed by the census work.

The next implementation requires Core's exact dormant apply/export ports.
These are required properties to resolve with Core, not invented API symbols or
an alternative schema:

1. Export identifies source/schema versions, consistency cut and covered stores;
   records exclude credentials, sessions, active routing and uncertain effects.
   Missing ownership, lineage, retention or state mappings quarantine explicitly.
2. Dormant apply accepts canonical mapped identities and content digests, returns
   durable batch provenance and per-record outcomes, and cannot intake/dispatch.
   Imported operational records remain PAUSED. Replays deduplicate; conflicting
   identities retain original evidence and sticky dependency quarantine.
3. Rollback uses durable provenance plus before/after revision checks, never a
   broad deletion by mapped ID or a restore of the complete pre-import store.
   Exact batch-owned, unchanged imported projections may be deactivated through
   Core's approved operation. Legacy source data is always preserved.
4. Post-import V2-only writes/deltas, shared references, changed ownership,
   uncertain effects and revision conflicts must survive rollback. Such cases
   require reconciliation/hold, not deletion. Quarantine/conflict history is
   retained even if a batch is deactivated, so replay cannot cleanse it.
5. Consistent export of dormant state and V2-only delta must be possible before
   rollback. Restore goes only to a fresh inactive target. Local recovery backup
   containing auth/session rows remains distinct from migration export.

Deterministic acceptance scenarios for the future real ports:

| Scenario | Required result |
|---|---|
| Same snapshot twice | Same IDs/digests; no duplicate Core records or effects |
| Changed identity followed by original replay/new child | Sticky quarantine including implicit ownership closure |
| Batch with paused operational records | No intake, scheduler, route, approval consumption or dispatch |
| Rollback repeated | Same inactive outcome and retained audit evidence |
| V2-only write after import | Delta preserved; stale revision produces hold |
| Shared/new dependent reference | No dangling reference or broad cascade |
| Failed apply/export or partial receipt | No claimed completion; deterministic reconciliation needed |
| Cancelled/uncertain legacy effect | No replay or inference that cancellation undid the effect |

Current executable synthetic coverage includes idempotency, sticky quarantine,
implicit thread ownership, paused operational plans, fresh inactive bundle copies
and V2-only ledger recovery. It does not exercise any real dormant store port.
The scenarios above are unexecuted against Core because those exact contracts
have not been delegated. Precise dependency: Core/coordinator should identify
its dormant apply/export and provenance/revision/deactivation interfaces so
Migration can implement adapters and these acceptance cases without editing
Core schema or inventing a parallel store.
