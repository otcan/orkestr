# Semantic inventory: minimal proposed projection

The root-executed live count receipt has been read privately. It establishes
successful per-store count observations on the reviewed thread/job stores.
Its counts, paths, runtime identifiers and table availability remain private.
Code-only census is no longer a blocker. These observations do not establish
cross-store coherence, activity, installed connector use or release coverage.
Empty or absent job records cannot establish unused workflows elsewhere.

`v2/migration/usage_projection.py` proposes the next bounded edge. It is tested
only on synthetic stores; root independently reviewed the exact committed projection and executed it
under a bounded process. Migration subsequently reviewed the private receipt.
The statements below describe the original projection contract. It reuses the reviewed mode=ro pinned transaction and ordinary-table
checks, then narrows its authorizer to `runs.state`, empty-column count reads
and count/sum/coalesce. No identifiers, timestamps, JSON payloads, provider names,
route data, credentials or result bodies are selected. No schema initializer,
registry/profile access or dispatch occurs.

## Exact query and interpretation

The source enums are
`packages/core/src/agent-job-store.js::RUN_ACTIVE_STATES/RUN_TERMINAL_STATES`,
at the pinned source baseline
`76f9c6cd91e094329ae5c29c7e95f301366ed02a`.
The fixed query consists of `count(*)` and eight repetitions of:

```sql
coalesce(sum(CASE WHEN state = ? THEN 1 ELSE 0 END), 0)
```

from the ordinary main `runs` table. Bound values, in order, are `pending`,
`running`, `retrying`, `awaiting_approval`, `succeeded`, `failed`, `cancelled`,
`skipped`. Unknown count is total minus these buckets, including null values.
Raw/grouped state strings never leave SQLite. Future enum changes require
explicit mapping review; they are not guessed from arbitrary stored values.

These are persisted lifecycle observations, not verified current execution.
No age or heartbeat criterion is inferred. Nonzero terminal buckets show stored
history of the corresponding outcomes, not completeness or effect success.
Cancelled state never implies an effect was undone. No automatic import policy
is derived from these observations.

The authorizer is defense in depth around fixed internal SQL. It is not a
privacy boundary for arbitrary SQL supplied by a caller with this connection:
SQLite necessarily permits state reads to evaluate CASE. The public function
accepts only a path and exposes no SQL/connection parameter.

## Remaining workflow inventory

| Class | Smallest next reviewed evidence | Current gap |
|---|---|---|
| Job lifecycle | Fixed state buckets above | Executed by root; no real-time activity proof |
| Thread role / workers | Source-validated fixed enum aggregate in storage-side projection | Role/lineage embedded in thread JSON; JSON body reads remain excluded |
| Provider class | Fixed provider enum normalization inside a reviewed source projection | Fixed enum candidate now in `workflow-class-projection.md`; live execution pending review |
| Timers / automation / setups | Safe status projection returning only known class/enabled buckets | Registry JSON and prompt-bearing definitions remain excluded |
| Connectors / browser / desktop | Reviewed status API with fixed capability classes and no identities | Session/profile/route and lease contents remain excluded |
| Tasks / resources / results / memory | Feature-aware schema/status projections with missing-store coverage | Job tables do not cover every authority/store |

No public artifact includes actual usage counts. Actual aggregate outputs must
remain in the authorized private report directory (0700; reports0600). Do not
print raw SQLite exceptions or outputs into CI. Full used-workflow coverage
requires each authority to explicitly report coverage and exclusions.

Validation: 52 synthetic tests pass using the migration test discovery command,
including four new projection tests for fixed/unknown buckets, empty-store
semantics, forbidden columns/functions and view refusal. Root subsequently executed the reviewed run-state projection and Migration
reviewed its private receipt. Provider/role/registry queries and CI for this
follow-up remain unexecuted.
