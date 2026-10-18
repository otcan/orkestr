# API v0: durable intake slice

This is a reviewable first increment, not M1 completion. Shared types are in
`v2/crates/contracts`; synthetic examples are in `v2/fixtures`. Scope uses a
serde-tagged object: `{"kind":"global"}` or
`{"kind":"project","project_id":"<uuid>"}`. IDs are distinct UUID newtypes.

Implemented routes:

| Route | Input / result |
|---|---|
| GET `/api/v2/health` | Public liveness only; runtime disabled, fixture mode false |
| POST `/api/v2/setup` | `{username,password}` plus `x-orkestr-bootstrap`; 201 with global conversation ID, 409 on rebootstrap |
| POST `/api/v2/session` | `{username,password}`; bearer token, type, expiry seconds, global conversation ID |
| GET `/api/v2/projects` | `{projects,next_cursor}` |
| POST `/api/v2/projects` | `{client_request_id,name}`; Project, 201 new / 200 duplicate / 409 conflict |
| GET `/api/v2/conversations/{id}` | ConversationSnapshot |
| POST `/api/v2/conversations/{id}/messages` | MessageInput; Receipt, 202 new / 200 duplicate / 409 conflict |
| GET `/api/v2/conversations/{id}/events` | SSE `message_accepted`, JSON EventEnvelope, numeric sequence `id` |

All routes except health, guarded bootstrap, and sign-in require
`Authorization: Bearer <token>`. No ambient cookie authority is used in this
increment; browser clients use authenticated fetch, including streaming fetch
for SSE. Native EventSource cannot attach this header. Tokens expire after 12
hours, are stored only as SHA-256 hashes and are returned with `Cache-Control:
no-store`. No persistent browser token storage implementation is provided.
Passwords are Argon2id hashes. Setup requires an operator-supplied random token
of at least 32 bytes via `ORKESTR_V2_BOOTSTRAP_TOKEN`; no shared/default password.
Auth endpoints share a conservative instance-wide limit of 10 requests/minute.
Origin, when supplied, must match the server bind origin exactly. No CORS grant
is emitted. Native clients may omit Origin. Loopback binding is mandatory.

Projects and snapshots accept `after` (exclusive sequence) and `limit` (1..100,
default 50). Follow `next_cursor` until null. Snapshot `last_sequence` is a
watermark; finish pagination before reconnecting SSE from that watermark.
SSE uses `Last-Event-ID` in preference to `after`. Cursor zero replays all
retained events; each stream reads at most 100 events at once, waits for network
backpressure, and never holds a write transaction. There is no retention pruning
in this slice. Negative/ahead cursors are rejected; an ahead event cursor yields
409 `resync_required`. A storage failure after stream headers emits
`resync_required` and closes; session expiry emits `session_expired` and closes.
Message text is fetched through snapshots; events carry only message references.
The owner ID is the authenticated canonical owner ID, never a provider ID.

JSON command bodies reject unknown fields. Client actor/owner claims cannot
be admitted. Message text is nonblank, at most 32768 UTF-8 bytes; request keys
are 1..128 ASCII alphanumeric or `-_.:`. Project names are nonblank and at most
200 bytes. HTTP JSON bodies are bounded to 40 KiB. After HTTP headers have
been parsed and the request enters application middleware, handler execution
until a response is returned is bounded to 10 seconds. This includes JSON body
extraction inside the handler, but does not establish a transport deadline for
receiving request headers. No explicit request-header timeout is configured by
the server. SSE response bodies stream beyond the handler deadline.
API failures use `{code,message,request_id,retryable}`; malformed path extraction
at framework routing boundaries may use Axum's rejection response.

The store reserves a short SQLite write transaction before checking request-key
replay. A SHA-256 digest covers the exact accepted text/name, including whitespace.
Message, metadata event, ordered reasoning inbox entry and outbox entry commit
atomically under WAL with synchronous FULL. No provider is called. A duplicate
returns the original IDs and does not enqueue again. Ordering is per conversation,
independent of wall-clock order. Migration `0001_intake.sql` is the authoritative
schema; runtime lanes must request additive migrations through Core.

Store startup validates the absolute canonical parent and all database, `-wal`,
`-shm` and `-journal` entries before opening SQLite. Symlinks (including dangling
ones), non-regular files and Unix files with link count other than one are
refused. Existing files on non-Unix hosts fail closed pending an equivalent
hardlink check. The caller must control the parent directory throughout startup;
this check is not a sandbox against concurrent replacement by a filesystem
writer. Foreign/future database identity refusal and byte preservation remain
separate, pending acceptance; path checks alone do not establish those properties.

Project resource status is deliberately `local_git=not_provisioned` and
`local_oxrm=unverified`. No Git workspace or OXRM readiness is claimed.
Runtime sessions, claims/leases, tasks, cancellation/effect fencing, approvals,
UI, device auth, logout/revocation and memory are subsequent increments. Unknown
routes are unavailable; none grant effects. Full M1 acceptance remains pending.

Existing database startup now preflights an expendable main-file/WAL copy before
opening the source in SQLite. The candidate must have WAL mode, an exact supported
prefix of SQLx migration checksums and matching schema (including indexes/triggers).
Pre-existing empty/foreign files, unsupported or altered histories/schemas, rollback
journals and orphan sidecars are refused. The copied SHM is rebuilt privately; no
read-only SQLite connection is opened against the original during refusal. This
is not a concurrent backup API: the caller must prevent replacement or concurrent
schema migration, and incomplete copies fail closed. Source-byte preservation
regressions, including live uncheckpointed WAL, are authored but not yet executed.
