# Attachment integrity checkpoint

The initial 9788ef14d checkpoint was a pure contract/validator. The persisted
schema38 successor below implements Store storage/export/import/download ports;
HTTP registration remains separate. Existing Message/Event bytes and schemas are
unchanged. UUIDs and metadata are locators, never authorization.

`AttachmentManifest` JSON fields: `schema_version` (exactly 1), `manifest_id`,
`owner_id`, `conversation_id`, `references`. Each `AttachmentReference` has
`reference_id`, `message_id` (UUID or null), `filename`, `media_type`,
`byte_length`, `sha256`, `state` (`available` or `removed`). Unknown fields refuse.
All IDs must be nonnil. References are unique within the manifest. At most 128
references, each and aggregate declared length at most 16777216 bytes. Empty
available content is valid with SHA256 of empty bytes. Removed references retain
original length/digest/name/media/message metadata but have no bytes.

Filename is a UTF8 basename, 1..255 bytes, excluding dot/dotdot, controls, slash,
backslash and colon. Media type is 1..127 ASCII bytes, exactly two nonempty token
components separated by slash; permitted token characters are alphanumerics and
`!#$&^_.+-`. Parameters are excluded. SHA256 is exactly 64 lowercase hexadecimal
characters over raw bytes (no text normalization).

`attachment_integrity::validate_attachment_bytes(manifest, owner, conversation,
reference_uuid, Option<&[u8]>)` checks structural validity, exact scope/membership,
state, length and digest. This does not authenticate the supplied owner.
`validate_attachment_copy(source,target,&[(source_uuid,target_uuid)])` requires a
complete bijection, new manifest/reference UUIDs disjoint from source reference
IDs, unchanged name/type/length/digest/state, and null target message bindings.
Target scope is selected separately by an authenticated importer. Message linking
requires a separate verified message mapping; this checkpoint deliberately does
not authorize such a mapping. No native input/admission is created.

## Initial authority/storage proposal (superseded by persisted successor below)

Core reserves new `attachment_store/` modules and proposes a new migration slot
38, subject to coordinator reservation. Tables: immutable owner/conversation
manifest/reference metadata, separately removable byte objects, and authenticated
import idempotency/provenance receipts. Content is bounded SQLite BLOBs in this
first implementation; no caller file paths or network fetches. Foreign keys bind
optional message linkage to the exact conversation. Removal erases bytes while
preserving reference metadata, and replay cannot restore removed bytes.

Proposed Store ports take the original browser credential, validating current
session/owner inside the same transaction before fresh writes or historical
receipt replay: `import_attachment_bundle_authenticated(credential, request,
bytes)`; `attachment_manifest_authenticated(credential, conversation, manifest)`;
`download_attachment_authenticated(credential, conversation, manifest, reference)`;
`remove_attachment_authenticated(credential, conversation, manifest, reference,
request_key)`. Exact request/receipt types require a subsequent contract review.
Export captures manifest and bounded available bytes at one read snapshot with
fresh authentication immediately before delivery. Import uses fresh target IDs,
explicit provenance mapping and immutable semantic key; changed replay conflicts.
No actual data will be imported in development/tests.

Proposed route (UNREGISTERED, do not call): GET
`/api/v2/conversations/{conversation}/attachments/{manifest}/{reference}`.
Authenticated 200 contains raw identity bytes; no redirect or Content-Encoding;
Content-Type from validated manifest, Content-Disposition attachment with safely
encoded filename, Content-Length exact length, Cache-Control private,no-store,
X-Content-Type-Options nosniff. Client treats manifest length/digest as integrity
source, rejects redirects/encoding and verifies before save. Authenticated removed
reference returns 410 without bytes; missing or foreign reference 404, expired
session 401. No active route/status claim is made. Coordinator owns registration.

## Persisted successor (schema 38)

The successor adds `AttachmentState::Inert` (`"inert"`) to preserve legacy
references outside active limits. No bytes may accompany inert references and
none can be downloaded, removed, promoted, or executed through these ports.
Their filename is preserved as opaque UTF8 (1..4096 bytes), media type <=1024
bytes, digest descriptor <=128 bytes, all excluding NUL; their declared length
may exceed the active byte cap. These descriptors are not validated download
filenames, media headers or content hashes. The total reference count still
cannot exceed 128: larger bundles must be explicitly partitioned by the producer,
never silently truncated. Active/removed aggregate lengths remain <=16MiB.

`AttachmentBundle` is `{manifest, contents:[{reference_id,bytes:[0..255,...]}]}`.
Contents contain exactly one entry for every available reference, including
zero-byte content, and none for removed/inert references. Arrays are octets, not
base64. Strict serde DTOs reject unknown fields. HTTP JSON body cap is 68MiB;
raw byte cap remains 16MiB aggregate. Imports do not normalize or silently mark
available bytes inert; the producer must explicitly retain an inert descriptor.

`AttachmentImportRequest` is `{request_key,source:AttachmentBundle,
target_manifest:AttachmentManifest,mapping:[{source_reference_id,
target_reference_id}]}`. Keys are 1..128 UTF8 bytes with no controls. Full mapping
must preserve every source descriptor including tombstones/inert references.
Target message IDs must be null; original source manifest/message identities are
retained in import provenance, without claiming native target message bindings.
A future message-linking port needs its own reviewed exact-message mapping.

Registered Store module is `attachment_store`:

- `import_attachment_bundle_authenticated(credential:&str,owner:&OwnerId,
  conversation:&ConversationId,request:&AttachmentImportRequest)` ->
  `Result<AttachmentImportReceipt>`.
- `attachment_manifest_authenticated(credential,owner,conversation,manifest:Uuid)`
  -> `Result<AttachmentManifest>`.
- `export_attachment_bundle_authenticated(credential,owner,conversation,manifest)`
  -> `Result<AttachmentBundle>`.
- `download_attachment_authenticated(credential,owner,conversation,manifest,
  reference:Uuid)` -> `Result<(AttachmentReference,Vec<u8>)>`.
- `remove_attachment_authenticated(credential,owner,conversation,manifest,
  reference,request_key:&str)` -> `Result<AttachmentRemovalReceipt>`.

Every port checks original current credential, owner and conversation in its own
transaction; bound provider handles refuse. Writes use BEGIN IMMEDIATE before
receipt lookup. Import receipt is immutable, includes import UUID, original target
manifest, source manifest UUID and exact mapping. Identical replay after removal
returns that original receipt without restoring bytes. Read manifest/export
reflect current tombstones. Changed semantic request conflicts. Serialization
order of references/content/mapping is semantic; producers must retain the exact
request on retry. A distinct key cannot reuse an existing target manifest/ref.

Export captures metadata and all bytes in one fixed read transaction and verifies
every available object's length/hash. Export/download recheck fresh session auth
outside the cut before returning bytes. Removal committed concurrently after a
read cut can still precede transport delivery of that earlier cut; clients must
revalidate tombstones and discard cached text/bytes on removal. No promise to
recall already delivered bytes is made. No filesystem paths, locators, native
input, journal revision, inbox, outbox, provider or task state is created.

Error enum: Invalid (400), Unauthorized (401), NotFound (404, also foreign scope),
Removed (410), Inert (409, explicit unsupported descriptor), Conflict (409),
Unavailable (503). Parentheses specify proposed server mappings, not active
routes. Isolation owns new attachment_transfer server leaf; coordinator owns
registration. Proposed export path is GET
`/api/v2/conversations/{id}/attachment-manifests/{manifest}/export`; import is POST
`/api/v2/conversations/{id}/attachment-imports`. Removal is not activated until a
server route is explicitly agreed. Public original owner IDs supplied in JSON
never establish auth; server derives the owner from the original cookie session
and Store revalidates that credential.

Opt-in `fixture-test-controls` adds AttachmentImportBeforeCommit/AfterCommit and
AttachmentRemoveBeforeCommit/AfterCommit to the existing authenticated
`production_arm_history_checkpoint` facility. Markers are respectively
`attachment-import-before-commit`, `attachment-import-after-commit`,
`attachment-remove-before-commit`, `attachment-remove-after-commit`. Each is after
all writes or after durable COMMIT before receipt. No production bootstrap arms
these facilities. Process tests use actual owned SIGKILL and fresh executable
retries, rather than pool reopen as lost-ack evidence.

Authored verification for the persisted slice: required-wrapper locked/offline
feature-enabled attachment filter 12/12 passed (including two existing metadata
attachment tests); five storage tests cover corruption, current-auth refusal,
removal/replay, inert references and two-pool atomic import. The process parent
covers four actual SIGKILL pre/post-commit windows and eight fresh-exec retries;
the helper entry is included in the test count. Preflight 10/10 passed, including
populated known-prefix 14/17/31/33/36/37 -> 38 copy-first preservation and untouched
rollback source. Strict feature all-target Store Clippy, workspace formatting and
diff checks passed. These are synthetic Store/process results, not HTTP, browser,
real-data migration or release acceptance.

Reload discovery successor (no schema change):
`attachment_manifests_authenticated(credential,owner,conversation,
after_id:Option<Uuid>,limit:u16) -> AttachmentManifestPage`. The page contains
`owner_id`, `conversation_id`, echoed `after_id`, `next_after_id` and `manifests`.
Limit is 1..16; nonnil UUID cursor is exclusive in canonical UUID string order.
A limit+1 query determines whether another page exists; null next cursor means
end. Each page is one read cut with current tombstones and fresh post-cut auth;
concurrent inserts can require refresh from the first page. Pages are not one
historical snapshot. Empty pages still project authenticated owner/conversation.
The selected server leaf route is GET
`/api/v2/conversations/{id}/attachment-manifests?after_id=<uuid>&limit=16`
(omit after_id for the first page). Same typed errors as other attachment reads.

Canonical `BrowserSessionProjection` adds `owner_id` alongside existing
`csrf_token` and `global_conversation_id`. Coordinator owns browser session body
mounting: obtain owner from existing current Store authentication, never from
request JSON, route IDs or a cached browser assertion. Isolation owns discovery
route implementation. Core makes no shared server or UI edits. The projected
owner is useful for target manifest construction but never grants import/read
rights; the original credential is authenticated again inside every Store port.
Discovery regression passed through the locked/offline wrapper: empty owner
projection, exclusive pagination, tombstone reflection, invalid limit, foreign
conversation and revoked current session. Strict feature all-target Store Clippy,
workspace formatting and diff checks passed. HTTP mounting is separately owned
and was not executed by this Core checkpoint.
