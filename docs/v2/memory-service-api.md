# Consented Memory Store API (schema41)

This implements the first persisted Memory operation from the canonical
personal-agent-memory service: explicit consented structured save, retrieval,
correction, forget and export. It is synthetic-tested and unmounted. It provides
no provider, task, timer, send or instruction authority and imports no live data.

Core owns `contracts/src/memory.rs`, Store `memory/` and
`0041_memory_authority.sql`. No dependency or existing migration changes.

## Authentication and consent

All public methods take the original `browser:` namespaced credential. Each
transaction derives the current owner from its unexpired auth row before any
lookup or receipt replay. Bare machine credentials and supervisor-bound Stores
refuse. Service selection defaults off; explicit trusted owner interaction may
call `set_memory_enabled_authenticated(credential, enabled)`.

`propose_memory_authenticated(credential, request_key, operation)` returns a
normalized schema1 `MemoryProposal` and SHA256 digest without persisting a
candidate. `save_memory_authenticated(credential, &proposal, &decision)` commits
only an exact `MemoryOwnerDecision { action, digest }`. The trusted future owner
controller must obtain explicit interaction; login, JSON source labels and a
digest alone are not consent. No HTTP route is activated here.

Operations are `Create { candidate }`, `Correct { memory_id, expected_revision,
candidate }` and `Forget { memory_id, expected_revision }`. Remember is restricted
to the current owner's own source identity; other sources require Approve.
Correct/Forget require their matching action. Trust is service-derived.

A request key is bounded to128 bytes. Exact retries return the original opaque
`MemoryReceipt { memory_id, revision, forgotten }`; changed digest/action conflicts.
Current auth and enabled state are checked first. Correction replaces content;
forget deletes content and provenance. Historical receipts cannot resurrect it.
Only IDs, revisions, action and digest remain in retry records. Physical SQLite
page/backup erasure is outside this operation.

## Records and reads

The six structured categories are preference, fact, decision, commitment,
open_loop and project_summary. Contracts reject unknown fields; validation checks
byte limits, source identifiers, timestamps, owned project/task/event references
and immutable correction scope. Timestamps use epoch milliseconds. Project
summaries require project scope. A record cannot assert current task status.

`retrieve_memories_authenticated(credential, &MemoryQuery)` reads owner records
plus one explicitly selected owned project, project first then update/ID order.
Limit is1..100; literal Unicode lowercase substring search is bounded to256 query
bytes. This first slice does not implement the JavaScript service's NFKC search
normalization. It never fetches source transcripts.

`export_memories_authenticated(credential)` returns all current owner records or
refuses above5000; no silent partial export. Fresh creation also enforces5000.

`memory_context_authenticated(credential, &query, max_bytes, max_records)` wraps
whole escaped records in a data-only warning and JSON envelope. Maximum64000
UTF8 bytes and100 records; callers may choose8192/32. Provenance and framing count.
Oversized records are omitted whole; omitted_count describes this bounded query
result, not an unbounded corpus census. Remembered instruction-looking text is
quoted data, never an instruction or action permission.

## Validation evidence

Nine ordinary Store tests cover durable save/reopen, default-off behavior,
external proposal approval, changed consent/digest/key, correction/forget CAS and
non-resurrecting retry, current revocation/expiry/disable, project isolation,
foreign credential refusal, whole-record context bounds, all categories and
record limits, plus a separate-pool retry race. No provider, HTTP, private-memory
import or activation acceptance follows from those tests.

The complete Store library run passed311 tests with zero failures and three
owned-subprocess helper entries ignored. This includes the supported populated
copy-first prefixes14/17/31/33/36/37/38/39/40 to41, existing-row equality,
foreign-key checks and empty new Memory tables. Strict fixture-test-controls
all-target Store Clippy, workspace formatting and diff checks passed. These
checks do not qualify HTTP composition or private content migration.
