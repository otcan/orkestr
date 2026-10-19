# Attachment integrity checkpoint

This checkpoint is a pure contract/validator, not storage, authenticated export,
import, or download implementation. Existing Message/Event bytes and schemas are
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

## Next authority/storage proposal (not implemented)

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
