# Browser Memory HTTP leaf

This unmounted leaf composes the authenticated Store Memory API. Coordinator
alone registers `mod memory_service` and merges
`memory_service::router(state.clone())` inside the canonical guarded router.
No AppState/config/schema changes are required. The state argument installs the
same browser guard independently for isolated composition. No provider, capture,
context injection or automatic approval endpoint is provided.

| Method/path | Strict JSON request | Successful response |
|---|---|---|
| GET `/api/v2/memory/settings` | none | `MemorySettings {owner_id,enabled}` |
| PUT `/api/v2/memory/settings` | `{enabled:bool}` | 204, no body |
| POST `/api/v2/memory/proposals` | `{request_key,operation:MemoryOperation}` | normalized `MemoryProposal` |
| POST `/api/v2/memory/decisions` | `{proposal:MemoryProposal,decision:MemoryOwnerDecision}` | historical `MemoryReceipt` |
| POST `/api/v2/memory/query` | `MemoryQuery {project_id,query,limit}` | `{records:MemoryRecord[]}` |
| GET `/api/v2/memory/export` | none | `{records:MemoryRecord[]}`, attachment `memory-export.json` |

DTOs are the exact strict contracts in `contracts/src/memory.rs`. Query text is
at most256 UTF8 bytes; limit1..100. Unknown fields and URL queries refuse.
Request bodies are limited to65536 bytes. Response serialization is bounded
before publication: ordinary JSON65536 bytes, query4194304 bytes, export8388608
bytes, including envelope/escaping. Overflow returns422 `memory_limit`, never a
partial list or prefix. Export is a separate bounded download, not a rendered
query. Store's5000-record complete-export ceiling remains independently enforced.

Revisions are canonical JSON u64 numbers, **not strings**. The client typed Rust
bridge must preserve original exact JSON integers, including values above
2^53-1. Never roundtrip revisions/CAS values through JavaScript Number. This
leaf does not reinterpret a changed integer as the original revision.

Only the original canonical browser cookie authenticates. Bearer credentials,
duplicate session cookies, foreign/missing Host and foreign/duplicate Origin
refuse. Mutations, including query POST, require canonical Origin and CSRF via
existing browser guards. The Store reauthenticates the original `browser:`
credential in each operation before record lookup or receipt replay. No request
owner ID grants authority. Settings owner_id is derived response identity only.
Every response, including extractor/method/auth errors, is `Cache-Control:
no-store`; `X-Content-Type-Options: nosniff` is also set by the leaf.

Errors use existing `ApiError {code,message,request_id,retryable}` with fixed
sanitized messages. Store mapping: Invalid400 `memory_invalid`, Unauthorized401
`memory_unauthorized`, Disabled409 `memory_disabled`, NotFound404
`memory_not_found`, Conflict409 `memory_conflict`, Limit422 `memory_limit`,
Unavailable503 `memory_unavailable`. Oversized bodies413
`memory_body_too_large`; malformed/content-type/body errors400 `memory_invalid`.
Canonical browser guards retain `origin_rejected`, `host_rejected`,
`csrf_rejected`, or shared unauthorized codes. Only503 is marked retryable by
the existing ApiError implementation; retries still retain the immutable tuple.

Explicit opt-in precedes proposal creation. The UI must display the normalized
proposal, obtain the exact matching action/digest confirmation, and retain the
entire proposal/key/decision for uncertain retry. Editing a draft invalidates
its confirmation. Conflict requires fresh retrieval/review. A historical retry
receipt is not current record content. Disable is not forget. Logout, owner or
project change must fence pending responses and clear volatile consent state.
No JSON label, login, source metadata or digest alone proves owner interaction.

Validation is isolated and synthetic: a disposable ordinary Store and owned HTTP
server, no real browser/lease/account/provider. Shared registration is added only
to a disposable composition copy, not committed. Production browser authority
and any operational hold remain independent gates.

Author validation on a dependency-complete disposable copy of the pinned Core
settings successor:2 tests passed, zero failed/ignored. One exercises the actual
owned loopback HTTP listener plus ordinary Store; the other exercises exact u64
and both full JSON response bounds. Strict server all-target Clippy passed with
warnings denied; formatting and diff checks passed. Other server/Store suites
were not rerun; no shared mount, browser, provider or production validation was
executed. The fixed synthetic test listener refuses port collision and never
probes another server. Registration remains a coordinator-owned integration step.
