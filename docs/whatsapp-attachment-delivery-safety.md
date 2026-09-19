# WhatsApp attachment delivery safety (ORK-501)

This change hardens partial-delivery handling. It does **not** establish the
cause of an existing provider media-upload failure or certify its recovery.

## Delivery behavior

- Preflight the selected local batch before sending cover text. Missing,
  non-file, unreadable and oversized inputs fail without a text-only success.
- Preserve a bounded, allowlisted partial result across the standalone worker,
  worker RPC, HTTP error boundary and mirror outbox. Raw exception strings,
  paths, filenames, account/chat bindings and credentials are not included.
- Each selected file has an ordinal and an outcome: `sent`, `not_attempted`,
  `failed_preflight` or `uncertain`. A provider result without an ID is uncertain.
  Exceptions after dispatch are not proof that nothing was delivered.
- Persist partial evidence in `brokerAck.partialDelivery` and metadata; the job
  becomes `partial_delivery`. The WebUI identifies incomplete delivery.
- Whole-job retry/replay is refused for partial jobs, including legacy dead
  letters whose error is `whatsapp_partial_delivery`. Automatic account-recovery
  replay excludes these jobs. Existing text/file acknowledgments must not be resent.
- Prose mentions of credential-like filenames are not implicit attachment
  approval. Explicit attachments retain the canonical owner/path/policy checks.

## SRE investigation and recovery

Inspect the owner-scoped outbox through the authenticated Orkestr interface.
Correlate a single job with its sanitized `stage`, `failureCode` and
`failureFingerprint`; do not dump its message body or source file content.
The low-cardinality counter
`orkestr_runtime_control_events_total{signal="transport_send",outcome="partial_delivery"}`
records mirror partial failures. Alert on any new partial delivery and inspect
existing outbox age/dead-letter monitoring; no identifiers belong in metric labels.

`reportWhatsAppAttachmentRecovery` is a pure report-only helper. It requires
owner, thread, account and incident start/end bindings. It never sends anything
or claims a record is safe to replay. Before any separately approved new send:

1. Check the latest source revision and verify the attachment still belongs to
   the same owner/thread/account; do not infer eligibility from text or timestamps.
2. Reconcile existing provider acknowledgments. Uncertain acknowledgments and
   legacy records without evidence require manual review.
3. Send only confirmed missing files, under a fresh approval/idempotency scope;
   omit already-delivered cover text and attachments.

## Remaining release work

- Diagnose the real provider media exception using the preserved evidence; do
  not label transport restoration complete based only on mocked tests.
- A process crash between provider acceptance and the final RPC response still
  needs reconciliation. This patch persists component results when the RPC
  returns; it is not a per-component write-ahead journal or exactly-once provider.
- Cross-host staging/access, stale-obligation alerts and an attended missing-file
  recovery workflow need integration validation. No historical bulk replay.
- Run the normal release train and tenant-isolation gate. Live sends, production
  deployment and recovery are separate approved operations, not part of unit tests.

Regression tests exercise local PDF/image/CSV sends through mocked clients,
preflight, first/second media failure, missing acknowledgment, service/RPC/error
propagation, durable outbox state, repeated scans, legacy replay refusal,
scope-filtered reports and credential-like prose/symlink references.
