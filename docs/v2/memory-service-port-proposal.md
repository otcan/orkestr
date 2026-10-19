# Consent-aware Memory service port proposal

Core owns new `contracts/src/memory.rs`, Store `memory/` modules/tests and
reserved migration `0041_memory_authority.sql`. No DDL is published by this
proposal. Schema40 workspace and its restart correction remain separate.
Consumers must wait for the committed typed implementation before imports.

The behavior source is `packages/core/src/personal-agent-memory-service.js`,
`personal-agent-memory-rules.js`, `personal-agent-memory-records.js`, and
`personal-agent-memory-context.js`, documented in
`docs/product/personal-agent-memory-service.md`. Preserve explicit consent,
structured categories, provenance, project scoping, correction/forget version
checks, literal bounded retrieval, and data-only context. No source transcript,
private memory, model call, embedding service or live import is needed.

## First concrete operation

A default-off trusted service selection exposes owner-authenticated proposal,
explicit save, retrieve, correct and forget. Every read/write takes the original
browser credential. The transaction authenticates its current owner before any
lookup/replay; machine/supervisor credentials and provider output cannot consent.
An owner UUID in a DTO or a digest is not authentication. Existing auth schema
must be inspected for a durable browser-versus-machine discriminator before
selecting the exact credential wrapper; if absent, a trusted server-only owner
request issuer must bind the original credential, never a caller JSON role.

Proposed typed operations (names are provisional until implementation pin):

- `propose_memory_authenticated(credential, MemoryInput) -> MemoryProposal`:
  normalized transient candidate and SHA256 operation digest, no row/event/log.
- `save_memory_authenticated(credential, MemoryProposal, MemoryOwnerDecision)
  -> MemorySaveReceipt`: current auth, exact digest/action, scope and key check
  in one immediate transaction. `remember` is owner-authored only; external
  proposals require `approve`. Consent must originate in explicit trusted owner
  interaction. Browser login alone does not manufacture it.
- `retrieve_memories_authenticated(credential, MemoryQuery) -> MemoryPage`:
  owner scope, or owner plus one exact owned project; max100, deterministic
  project-first/update/ID ordering and literal content search, no source reads.
- Correction/forget proposal and commit bind exact memory UUID plus monotonic
  revision; concurrent stale decisions refuse without partial writes. Correction
  replaces content without retaining the old content. Forget removes content
  and provenance, including any content-bearing idempotency material. Opaque
  non-content decision receipts may remain only if required for safe retry.

The first persisted positive path must save and retrieve a synthetic structured
fact through these actual Store methods; flags alone cannot qualify Memory.
Storage approval grants no instruction/effect, task, timer or provider authority.
Imported records are dormant proposal evidence until a fresh owner decision.

## Canonical data and bounds

Preserve six categories and their existing required fields/byte bounds:
preference key/value128/4096; fact statement4096; decision summary4096 and
optional rationale2048; commitment/open_loop summary4096 with optional same-
project task and canonical due time; project_summary8192 with project scope.
Unknown fields/categories, invalid IDs/times, empty/oversized values refuse.
Provenance contains source kind, opaque actor, origin, captured time and optional
same-project task/event references; trust is service-derived owner-authored or
owner-confirmed, never source-assigned. No source bodies or credentials.

At most5000 current records per owner; reads query one excess row and fail on
limit rather than silently export incomplete data. Context uses whole escaped
records under a data-only header; default8192/max64000 UTF8 bytes, max32 records
by default. Scope/provenance/framing count toward the budget. No instruction role
or current task status is invented from stored text. Stable export includes
current consented records only; physical backup/page erasure is not promised.

## Required negative vectors

Revoke/expire original credential before fresh commit and before historical
receipt replay; foreign owner/project/task; missing/changed consent/action/
digest/key; external source claiming owner trust; stale correction/forget;
concurrent same-key winner; correction leaves no old content; forget leaves no
content-bearing row/receipt; scoped retrieval cannot expose another project;
instruction-looking text stays quoted data; exact whole-record context cap;
reopen durability; disabled service refuses before writes. No live provider,
connector, private-memory import or route activation in this checkpoint.

Server/UI owner interaction and canonical authenticated request issuance require
separate reviewed composition. No HTTP route or activation is proposed here.
