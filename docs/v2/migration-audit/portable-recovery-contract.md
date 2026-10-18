# Portable recovery contract checkpoint

`v2/migration/recovery_bundle.py` implements a bounded canonical JSON collector
envelope and deterministic validation. It preserves the original ledger request,
current active/inactive receipt and complete published native conversation delta.
It rejects partial pages, changed source fingerprints, overlapping source message
identities, unknown fields, malformed/noncanonical envelopes and false coherence
claims. Its digest detects alteration; it authenticates neither provenance nor a
shared transaction. All supplied components remain explicitly unattested.

The separate unregistered `history_import/recovery_export.rs` publishes the exact
proposed Store DTOs and domain-separated binary bundle fingerprint. The Python
JSON envelope digest and Store binary bundle fingerprint are distinct contracts;
no adapter claiming equivalence is implemented. Core review is required before
connecting them. No shared registration, schema allocation or restore write is
included in this checkpoint.

Proposed Store methods, with target credentials always separate:

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

Core reserves migration 0020 for durable outer restore provenance, exact semantic
request fingerprint, immutable original receipt and rollback state. Current auth
must precede replay lookup. Identical replay returns that persisted original
receipt even after rollback; changed bundle or targets conflict. Bundle rollback
must verify the outer expected revision and both exact recorded child contents,
revisions and activity in one transaction before changing either child. Individual
rollback must refuse bundle-linked children. No restore writes will be added
against schema 16 alone; exact Core SQL and semantic-request encoding remain
integration dependencies.
No credential, native session, binding, route, timer, outbox, runnable admission or
external effect is copied. Delta content recovery does not restore execution state.

Executed: Python migration suite 115/115 PASS; rustfmt and diff checks PASS.
The unregistered Rust checkpoint has not been compiled or executed. Real Store
recovery export/restore, process-crash acceptance for these methods and portable
return to the legacy authority are unexecuted. Existing isolated dormant-import
and native-delta preservation tests remain separately documented.
