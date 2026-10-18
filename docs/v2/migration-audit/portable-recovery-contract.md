# Portable recovery contract checkpoint

`v2/migration/recovery_bundle.py` implements a bounded canonical JSON collector
envelope and deterministic validation. It preserves the original ledger request,
current active/inactive receipt and complete published native conversation delta.
It rejects partial pages, changed source fingerprints, overlapping source message
identities, unknown fields, malformed/noncanonical envelopes and false coherence
claims. Its digest detects alteration; it authenticates neither provenance nor a
shared transaction. All supplied components remain explicitly unattested.

The separate unregistered `history_import/recovery_export.rs` publishes the exact
module-owned Store DTOs and domain-separated binary bundle fingerprint. The Python
JSON envelope digest and Store binary bundle fingerprint are distinct contracts;
no adapter claiming equivalence is implemented. Core review is required before
connecting them. No shared registration or schema allocation is included. The owned schema-20
writer was executed only in the disposable synthetic candidate described below.

Owned Store methods, with target credentials always separate:

- `export_history_recovery(credential, owner, namespace, native_conversation)`
  returns `HistoryRecoveryBundle`. One bounded read transaction must verify current
  auth, retained ledger integrity and native conversation ownership/scope, then
  capture the complete native delta. Recheck current auth before delivery. The
  explicitly named recovery boundary may expose inactive retained text; ordinary
  inactive history reads continue to return no text.
- `restore_history_recovery(credential, target_owner, request)` returns
  `HistoryRecoveryRestoreReceipt`. One current-auth `BEGIN IMMEDIATE` transaction
  must refuse either occupied target namespace, validate the entire bundle before
  writing, use the sole ledger insertion helper for both inert batches, and retain
  original inactivity atomically. No partial success or native admission is valid.

Source namespaces must be distinct. Combined limits across both sources are
100,000 messages and 16 MiB of exact binary source encodings, including framing.
The separate JSON envelope remains bounded at 40 MiB. These aggregate checks apply
even when each individual source satisfies its own limits.

Each request preserves its own source scope, watermark, message order and binary
source fingerprint. The outer binary fingerprint also binds original source-owner
provenance, source namespaces and current ledger revision/activity. Target owner
and target namespaces are explicit new authority choices. Restore request and
receipt now carry an explicit nonnil `restore_id`. Freshness is a database
transaction predicate, not something the DTO validator can prove.

Core supplies migration 0020 for durable outer restore provenance, exact semantic
request fingerprint, immutable original receipt and rollback state. Current auth
must precede replay lookup. Identical replay returns that persisted original
receipt even after rollback; changed bundle or targets conflict. Bundle rollback
must verify the outer expected revision and both exact recorded child contents,
revisions and activity in one transaction before changing either child. Individual
rollback must refuse bundle-linked children. The owned methods require exact Core schema 20 and its semantic-request
encoding; they cannot run against schema 16 alone. Core registration and
independent review remain integration dependencies.
No credential, native session, binding, route, timer, outbox, runnable admission or
external effect is copied. Delta content recovery does not restore execution state.

Executed: Python migration suite 115/115 PASS; rustfmt and diff checks PASS.
The unregistered owned Rust source compiled and passed 14 selected Store tests
and strict feature-enabled all-target clippy in the disposable schema-20 candidate.
Exact hashes and commands are in [schema-20 recovery evidence](recovery20-build-evidence.md).
Recovery process-crash acceptance and portable return to legacy are unexecuted.

## Schema-20 implementation source checkpoint

Against exact Core schema handoff `bcd93cd3595b14eab817b65b97b56876afe37e26`,
new owned files implement recovery capture, transaction-local receipt validation,
restore and whole-bundle rollback. No shared registration or schema edits are
included. Core must register these internal sibling modules together:
`recovery_export` (public DTOs), `recovery_codec`, `recovery_capture`,
`recovery_restore`, `recovery_rollback`, and test-only `recovery_store_tests`.
The individual rollback hold and sole insertion helper extraction must accompany
them; adopting the hold requires schema 20, not schema 16 alone.

Restore authenticates before looking up an outer receipt. Both ledgers, their
associations and the immutable outer receipt commit together. Restore replay
verifies exact recorded children/content and returns the initial receipt without
reactivation. Rollback authenticates before replay, verifies the outer semantic
fingerprint and both children before changing either, retains all rows and returns
a persisted exact rollback receipt on identical replay. An inactive original stays
inactive. Occupied or swapped targets, changed input, tampered content/activity and
independently linked children refuse. The shared insertion helper remains the sole
history row writer. No runtime/execution tables are written.

The explicit recovery capture closes its query-only/trusted-schema-off connection
and rechecks current credential/conversation ownership outside the cut before
returning retained inactive text. It has a 60-second timeout, raw count/byte
preflights before loading text, complete fingerprint verification and aggregate
limits. Source namespace for the native delta is its conversation UUID; collision
with the original source namespace refuses. A single Store cut does not establish
legacy or multi-authority coherence.

Rollback request keys use 1..=128 exact UTF-8 bytes without control characters,
consistent with the existing durable stop-receipt key bound; no normalization.
The history contract previously had no request key. Core explicitly accepted this rule; it is independent of credential length limits.

Five new actual Store tests cover inactive-source capture, native delta content,
reopen/replay/whole-bundle rollback, credential revocation, occupied/swapped targets,
second-child abort atomicity, individual-child rollback hold and tampered content
or activity. All five passed, together with nine existing selected history tests,
under build admission against schema 20 with temporary internal registration.
The Python suite remains 115/115 PASS; rustfmt and diff checks PASS. Actual recovery
process-kill/crash acceptance is unexecuted and remains a separate verification gate.
