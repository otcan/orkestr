# Independent attachment roundtrip oracle

Migration owns only `v2/acceptance/attachment_roundtrip_oracle.py` and
`v2/fixtures/migration-audit/attachments/` for this oracle. Core owns authority,
storage and contracts; UI owns presentation/client verification; Isolation owns
the HTTP leaf and coordinator owns registration.

## Exact implementation under test

The original pure-validator checkpoint was Core `9788ef14d`. The persisted
successor is `9cd9268234f52581de260681bf926be9d77968ef`, including real migration38,
`attachments.rs`, `attachment_transfer.rs`, `attachment_integrity.rs` and
`attachment_store/{mod,read,write}.rs`. The preparation script verifies these
committed source bytes against its full revision pin, independently checks four
fixed byte vectors and emits Rust integration tests plus their JSON fixture.
It refuses a preexisting output directory and never runs Cargo or edits the
implementation checkout. A successor requires explicit source review and pin
refresh if any pinned implementation changes.

In a disposable archive of the pinned revision, install
`attachment_store_oracle.rs` and `attachment-cases.json` together in
`v2/crates/store-sqlite/tests/`. Use the required admitted build wrapper with
`test --offline --locked -p orkestr-v2-store-sqlite --test attachment_store_oracle`.
The separately emitted `attachment_integrity_oracle.rs` exercises pure checks;
its execution is distinct from the actual Store roundtrip.

## Independent expected results

Fixed synthetic byte vectors cover empty bytes, NUL/non-UTF8 and CRLF/LF, with
two distinct references sharing exact bytes. SHA256 and lengths are computed
independently in Python and retained in the fixture rather than trusting the
Store's self-reported digest. Rust asserts exact downloaded byte equality.

The Store oracle imports a source bundle, exports through the real authenticated
read cut, copies that bundle into a second fresh Store, closes/reopens it and
checks every available reference's downloaded bytes and metadata. It directly
checks persisted source-manifest provenance, including original message IDs;
target message bindings stay null. Removed metadata and out-of-cap `Inert`
descriptors remain preserved without downloadable bytes.

Negative cases cover corrupt bytes, truncation/missing content, duplicate
mapping, changed length, invented target message binding, foreign owner/scope,
changed semantic replay and revoked current session replay. A rejected import
must leave no usable partial target. Identical replay after removal returns its
original receipt and does not resurrect bytes. Native message/event/inbox/outbox
row counts remain unchanged across both copies.

## Executed scope and limits

The admitted exact schema38 build ran the two Store oracle tests successfully;
selected strict Clippy, Rust formatting and diff checks passed. Private receipts
retain exact source, fixture, binary, manifest/lock and log hashes. The emitted
pure-validator integration test is not included in that execution claim.

These are synthetic Store-port results, not HTTP, browser, production import or
new process-crash acceptance. They do not prove external source authenticity,
message-link mapping, live cross-authority export consistency, lossless legacy
reverse import, active authority restoration or recall of already delivered
bytes. Server transport must independently enforce auth, redirect/encoding,
size and tombstone semantics. UI must fence logout/late responses and verify
bounded streamed bytes before offering save; no auto-preview or execution.
