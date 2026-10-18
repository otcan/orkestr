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

Each request preserves its own source scope, watermark, message order and binary
source fingerprint. The outer binary fingerprint also binds original source-owner
provenance, source namespaces and current ledger revision/activity. Target owner
and target namespaces are explicit new authority choices. Freshness is a database
transaction predicate, not something the DTO validator can prove. Bundle receipt
persistence/deduplication and revision-held rollback of the two-batch restore need
an exact Core decision before a durable atomic replay guarantee can be claimed.
No credential, native session, binding, route, timer, outbox, runnable admission or
external effect is copied. Delta content recovery does not restore execution state.

Executed: Python migration suite 113/113 PASS; rustfmt and diff checks PASS.
The unregistered Rust checkpoint has not been compiled or executed. Real Store
recovery export/restore, process-crash acceptance for these methods and portable
return to the legacy authority are unexecuted. Existing isolated dormant-import
and native-delta preservation tests remain separately documented.
