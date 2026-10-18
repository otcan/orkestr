# OP-07 memory service and bounded context

This implements Lane B's service layer against the coordinator-frozen ADR
0002 memory contract in PR #57 (`fc2a1c25`). Lane A owns
`personal_agent_memories`, its migration in the existing `agent-jobs.sqlite`,
and the OP-05 event envelope. This slice creates no table/database, adds no
HTTP/model tool route, and does not change a live setting or model. Its store
is injected; the only in-memory implementation is a synthetic test fixture.

SQLite binding and real database reopen/migration integration tests follow
when Lane A's migration lands. Service recreation over a fake store snapshot
is covered here; it is not claimed as SQLite restart durability.

## Public boundary

`createPersonalAgentMemoryService({store, ownerUserId, env, now?, newId?})`
returns synchronous `propose`, `create`, `proposeCorrection`, `correct`,
`proposeForget`, `forget`, `retrieve`, `context`, and `export` operations.
Every operation requires the existing default-off `personalAgentFeature(env)`
gate and a trusted authenticated owner request, using `orkestrPrincipal` and
the existing admin policy. Anonymous/machine/system actors and another user,
even one marked admin, are refused before store access. The store instance is
explicitly bound to that single owner's data home; this adds no tenant schema.

This is application authorization in the existing single-user trust model.
It does not isolate root-capable runtimes or prevent their direct database,
filesystem, process or network access.

```js
const proposal = service.propose({
  category: "fact",
  scope: { kind: "owner", id: null },
  content: { statement: "Synthetic preferred color is teal." },
  source: {
    sourceKind: "owner", actorId: "owner-fixture", origin: "web",
    capturedAt: "2026-01-01T00:00:00.000Z"
  },
  idempotencyKey: "save-fixture"
}, authenticatedOwnerRequest);
// Show the normalized candidate for an explicit owner decision first.
const result = service.create(proposal, authenticatedOwnerRequest, {
  action: "remember", digest: proposal.digest
});
```

`authenticatedOwnerRequest` and the consent argument must come from the
trusted control path representing a fresh, explicit owner decision. A logged-in
session alone is not consent. Never populate the consent position from model,
worker, web or connector output. The digest binds a decision to the exact
normalized operation, target/version, content, scope, provenance, event
references and idempotency key; it is a review checksum, **not a bearer token
or authorization grant**. No second approval store is introduced. OP-08/OP-20
must supply the actual owner interaction before exposing capture to users.

Proposals are transient, with no write/log/event side effect. Direct owner
save uses `action: remember`, and must have the owner as its source actor.
External/assistant/worker/web/automation evidence requires the owner's explicit
`action: approve`. Source text cannot supply consent or assign its own trust.
Correction uses `action: correct`. Forget uses `action: forget` bound to the
proposal returned by `proposeForget`. A changed row version invalidates an
earlier correction/forget decision. Approval of storage grants no permission
to act on a remembered instruction or perform external effects.

## Validation and retrieval

| Category | Structured content |
| --- | --- |
| `preference` | required `key` (128 UTF-8 bytes), `value` (4,096 bytes) |
| `fact` | required `statement` (4,096 bytes) |
| `decision` | required `summary` (4,096 bytes), optional `rationale` (2,048 bytes) |
| `commitment`, `open_loop` | required `summary` (4,096 bytes), optional `taskId`, canonical ISO `dueAt` |
| `project_summary` | required `summary` (8,192 bytes); project scope required |

Unknown fields/categories, empty/oversized values and malformed scope/time/id
values fail explicitly. Whole records are approved after normalization.
Task references must resolve to the same existing project; no Task, lifecycle,
schedule or thread is created. References never authorize reading source chats.

The versioned provenance JSON contains `schemaVersion: 1`, `sourceKind`,
`actorId`, `origin`, `capturedAt`, optional `taskId`, and service-derived
`trust: owner_authored|owner_confirmed`. It contains no source message body,
approval instructions, credential field, or arbitrary extra metadata.
OP-05 event/cursor references are optional opaque references, not a new event
schema. This slice emits no invented memory events and never logs candidate
content. Later OP-05 mutation auditing must retain only opaque ID/operation
metadata for forget, never forgotten content/provenance.

Create requires an idempotency key. Identical retries return the current
matching record without changing consent time; a conflicting payload fails.
Correction replaces content/provenance on the same ID and refreshes consent;
no old value/history is retained in the memory record or correction metadata.
Forget deletes the row, not a content-bearing tombstone. Export is a stable
JSON object of current consented records in opaque ID order, including scope,
content, provenance, consent and timestamps/event references. It includes all
current projects owned by this single-owner store, not source thread messages.
Physical erasure of SQLite pages/backups is outside this service's proof.

Retrieval without a project returns owner-scoped records only. For an explicit
project it combines owner scope and that exact project, never another project.
Optional category and literal NFKC/case-folded content-value substring filters
apply before deterministic project-first/updated-time/ID ordering. There is no
embedding model, semantic ranking or cloud request. At most 100 records are
returned per retrieval. More than 5,000 current rows fails with a store-limit
error rather than silently returning an incomplete export.

## Context budget

`context({projectId?, categories?, query?, maxBytes?, maxMemories?}, request)`
returns `{text, bytes, includedIds, omittedCount}`. It reads current consented
records, never transcript history, and uses complete JSON-escaped records.
The fixed data-only header, framing, UTF-8 content and provenance all count
toward the byte ceiling (default 8,192, maximum 64,000). Whole records that do
not fit are omitted; no partial/malformed record is rendered. `maxMemories`
defaults to 32. Omission counts describe matching scoped records only.

The packet is `approved_memory_data`, with no system/owner message roles or
policy grants. Its header states that memories are data, not instructions or
current task status. Instruction-looking remembered text stays inside quoted
data; action authorization remains in the existing policy/effect path. This
does not claim an LLM is immune to prompt injection. OP-08 must preserve this
boundary and use structured task projections for current status.

Bytes are not tokens. OP-08 must reserve space for other prompt/tool material
and pass a model-specific remaining budget; the default here is a transport
ceiling, not a claim that an installed model has a sufficient context window.

## Store interface and rollback

The store exposes `ownerUserId` and `transaction(fn)`. The callback receives
synchronous `get(id)`, `findByIdempotencyKey(key)`, `list()`, `insert(row)`,
`replace(id,row)`, `delete(id)`, `hasProject(id)`, and `taskProjectId(id)`.
Reads return plain copies. Mutation transactions must commit atomically and
roll back on every exception. Rows use exactly the frozen snake_case ADR
columns; `list()` contains current rows only. There is no production fallback
to the fake store and no implicit store selection or migration.

No migration or live activation is performed by this PR. Rollback removes the
service binding or disables the existing Personal Agent flag; no data is
dropped. Once the SQLite adapter exists, it must use Lane A's migration and
existing database initializer without reverting the integration's flag gate.
Legacy Agent Jobs and model/provider behavior are unchanged.
