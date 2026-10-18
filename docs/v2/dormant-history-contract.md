# Dormant history ledger contract

Core owns `contracts/src/history.rs`, migration `0016_dormant_history.sql` and
shared registration. Migration owns only `store-sqlite/src/history_import/` and
its new tests. No duplicate Store, execution tables, canonical events, outbox or
inbox writes. These imports are HISTORY_ONLY and do not become conversation
input. Source IDs are provenance strings, never target authority or foreign keys.

Implement inherent ordinary Store methods (not provider-bound handles):

- `import_history(&self, credential: &str, owner: &OwnerId, request: &HistoryImportRequest) -> Result<HistoryImportReceipt, HistoryError>`
- `rollback_history(&self, credential: &str, owner: &OwnerId, request: &HistoryRollbackRequest) -> Result<HistoryRollbackReceipt, HistoryError>`
- `history_receipt(&self, credential: &str, owner: &OwnerId, namespace: Uuid) -> Result<HistoryImportReceipt, HistoryError>`
- `history_messages(&self, credential: &str, owner: &OwnerId, namespace: Uuid, after: Option<i64>, limit: u32) -> Result<Vec<Message>, HistoryError>`

`HistoryError` is module-owned: Invalid, Unauthorized, NotFound, Conflict,
Unavailable. No SQL errors or credential values in returned errors. Every method
checks current exact credential hash, owner and expiry using the Store clock in
its transaction. Writes use BEGIN IMMEDIATE; authentication precedes receipt
lookup. Bound production handles refuse. Token is a separate trusted argument,
never part of JSON. Authenticated reads of inactive batches return provenance
receipt but no message text. Page limit is 1..100, cursor is source sequence.

Import is one atomic batch. Namespace is a nonnil UUID unique within target owner.
Source conversation/message/project UUIDs must be nonnil. Watermark is nonnegative;
messages are strictly ascending positive source sequence <= watermark with unique
source IDs, actor_kind exactly owner (the currently published Message contract).
Empty batches are valid. At most 100000 messages, 16MiB canonical bytes total,
1MiB UTF-8 per text. No target conversation is created. Do not import credentials,
provider output, runtime bindings or inferred source authority.

Canonical digest is lowercase SHA256 of the following bytes, without JSON:
ASCII `orkestr-history-v1` followed by NUL; source conversation UUID raw16 bytes;
scope byte 0 for global or 1 then project UUID raw16; watermark big-endian u64;
message count big-endian u64; then for each ordered message: UUID raw16, sequence
big-endian u64, actor_kind and text each encoded as byte-length big-endian u64
followed by exact UTF-8 bytes. No normalization. Namespace and target owner are
not source content. Reject supplied source_digest unless exactly computed digest.
Expose `history_source_digest(&HistoryImportRequest) -> Result<String,HistoryError>`
from the module so producers/tests can share this specification; independently
pinned byte vectors must test implementations. Python uses UUID.bytes,
int.to_bytes(8,'big'), UTF-8 and hashlib.sha256.

Same namespace plus exact canonical content returns the original import receipt
(revision1, active true), even after rollback; this is an immutable historical
receipt, not reactivation. Changed input including truncation conflicts. Current
`history_receipt` reports revision2/inactive after rollback. Namespace cannot be
reused. First rollback requires expected_revision1 and untouched exact row count,
ordered digest and provenance. It retains all rows, sets active false/revision2
and timestamp atomically. Identical repeated rollback expected_revision1 returns
original revision2 rollback receipt; other revision conflicts. No edit/reference
API exists; future deltas/shared references must add a durable rollback hold
before exposing them. Never delete provenance or resurrect through replay.

Compatibility/source review precedes registration. Core will review implementation
and register reexports; Migration must not edit lib.rs, migrations or manifests.

Pinned empty global vector: source conversation `00000000-0000-0000-0000-000000000002`, watermark0, messages[]: canonical hex `6f726b657374722d686973746f72792d763100000000000000000000000000000000020000000000000000000000000000000000`, SHA256 `705fbd75e107ac9ebf0f4f5d1adb1ac05629d3b30b8abd8d674626f4aafc40e3`.

Ledger source_scope encoding is exactly `global` or `project:<lowercase hyphenated UUID>`; receipt schema_version1, initial revision1, rollback revision2. Source digest excludes the supplied digest field itself.
