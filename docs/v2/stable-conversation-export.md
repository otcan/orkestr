# Stable conversation export reader

The ordinary SQLite Store has an additive trusted export reader in
`conversation_export.rs`. It returns the existing `ConversationSnapshot` type;
the normal UI snapshot method and application trait are unchanged. This is one
V2 conversation cut, not a legacy exporter, multi-authority backup, importer,
rollback port or provider capability.

Minimal in-process API:

```rust,ignore
let mut export = store.begin_conversation_export(
    token, &owner, &conversation, ConversationExportLimits::default(),
).await?;
let cut = export.receipt().cut_id;
let page = export.page(token, &owner, cut, 0, 100).await?;
// Continue using exactly page.next_cursor until None.
// A caller abandoning a partial export should release it immediately.
export.release();
```

Only Store constructs the private, non-Clone, nonserializable handle. Its opaque
cut ID selects the already-owned handle; a receipt or caller-supplied UUID cannot
create authority. The fixed receipt contains owner/conversation, scope,
watermark, storage migration version and package version. It is metadata rather
than signed proof or a durable cross-process resume token. The reader selects
only published message fields, never credentials, provider bindings, routes,
runtime state or outbox contents.

Capture uses a single SQLite read transaction on a connection obtained from the
existing Store pool. `query_only=ON` prevents writes and `trusted_schema=OFF`
restricts schema behavior. It does not reopen a caller-selected path, initialize
schema, change journal mode, admit a message or copy a database. The connection
is marked close-on-drop before those settings and closed after capture, so the
settings cannot leak into pooled writers. The frozen data is materialized in
bounded private memory; no read transaction or WAL pin survives construction.
Subsequent writes are excluded, including changes before the first page.

Every page requires the original token verifier, owner, cut ID and sequential
cursor. The last awaited operation before delivery checks the current session's
expiry and current conversation ownership through a fresh autocommit query,
outside the historical snapshot. That read is the authorization linearization
point: revocation committed before it refuses the page and discards the cut.
Revocation cannot undo a page delivered earlier. A new session for the same
owner cannot revive an old handle. Authentication is also checked before and
after capture. No raw token is retained in the handle.

Limits are caller-reducible, with hard maxima of 60 seconds from capture start,
100,000 messages, 16 MiB canonical serialized data, 100 messages per page and 1,000 pages.
Capture checks row and raw-field bounds before loading payloads, then counts
canonical JSON bytes without allocating a second serialized body. The counter
matches the collector's ASCII escaping convention, including non-ASCII Unicode,
surrogate pairs and DEL; key sorting does not change byte length for these types.
Paging counts published page bytes, including repeated envelope fields. Small
page sizes can exhaust the cumulative byte/page budget even when the assembled
snapshot fits. That is an explicit incomplete export failure; callers must
discard partial output. No rows are silently truncated or skipped. This bound
is on content bytes and row count, not exact process RSS.

Expired, released, exhausted or fully delivered handles cannot page. Completion,
expiry checks and explicit release discard payload memory. Dropping a handle
also releases it; an idle expired handle cannot deliver data but its bounded
memory remains until checked, released or dropped. Sequential cursors reject
repeated or skipped pages. Abandonment or a lost result requires a new cut.
Export pages and receipts from real data must remain private and must not be
logged or committed.

Core owns registration: add `mod conversation_export` and re-export
`ConversationExport`, `ConversationExportError`, `ConversationExportLimits` and
`ConversationExportReceipt` after reviewing this scoped addition. No application
contract or manifest edit is needed. The module includes purpose-specific unit
tests using ordinary Store setup/intake, concurrent writers, current revocation,
wrong owner/cut/cursor, release/expiry, project scope, empty conversation, row,
serialized-byte and page limits. A complete-table equality oracle checks that
export/refusals do not change storage, and WAL truncation succeeds while an
unpaged export is still alive.

## Implementation checkpoint

Validated against exact Core `0bc3ffced736af222e4768f95f45f0d52d3518ae`, with
only this new module, its split tests and temporary registration in a private
source export. Eight focused tests passed, zero failed/ignored, in 3.57 seconds;
80 unrelated existing tests were filtered out. Selected strict clippy and
package format checks passed. Commands used the authorized build wrapper and
an isolated target/home:

```text
test --offline --locked -p orkestr-v2-store-sqlite --lib conversation_export::tests -- --test-threads=1
clippy --offline --locked -p orkestr-v2-store-sqlite --lib --tests -- -D warnings
fmt -p orkestr-v2-store-sqlite -- --check
```

All data was synthetic. No live export, importer, provider execution or release
qualification was attempted. Shared registration and downstream collector wiring
remain Core/Migration integration work; this checkpoint does not claim them done.
