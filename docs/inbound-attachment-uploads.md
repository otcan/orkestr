# Browser-encrypted inbound attachments

This capability protects an attachment from the browser until Orkestr has
accepted it into a tenant-scoped ciphertext quarantine. It is separate from
the existing browser-held recipient identities used for outbound downloads.
It does not make an approved attachment secret from the scanner, Orkestr, or
the agent that receives a released attachment.

## Transport encryption (trusted API)

For ciphertext-only browser uploads with ordinary server processing/storage:

```ini
ORKESTR_INBOUND_UPLOAD_ENCRYPTION_ENABLED=1
ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED=1
ORKESTR_INBOUND_UPLOAD_PROCESSING_MODE=transport
```

The browser encrypts the metadata and file stream using age's authenticated
chunked format before the PUT. The `application/age` body contains ciphertext,
not multipart plaintext. For compatibility with browsers without streaming
request support, the bounded encrypted chunks are buffered as a Blob; the
original file is never used as a network fallback. Control POSTs carry session
IDs and sizes only. This is one encrypted stream per file, not a resumable
per-chunk HTTP protocol.

The trusted API owns the decryption identity, verifies the complete stream,
descriptor, session, owner, limits and key status, then publishes normal file
bytes. Temporary partial plaintext is private and never published before final
authentication. This mode does not promise encryption at rest, secrecy from
the API, or malware scanning; `scannedAt` remains empty. It requires neither a
separate worker nor a service-identity migration. HTTPS and authenticated
public-key delivery remain required. Required mode rejects legacy plaintext
uploads, including while intake is paused or encryption is unready.

Do not switch existing isolated-worker key registries into transport mode
without key rotation: their identities are intentionally unavailable to the
API. Mode changes are operator decisions, never error recovery fallbacks.

## Isolated-worker activation boundary (default)

Inbound encryption is off by default. In `isolated-worker` mode, intake needs the dedicated
[isolated worker contract](inbound-attachment-worker.md), including an
approved scanner. The API process never decrypts production ciphertext and
never stores an inbound age identity or worker signing private key.

```ini
ORKESTR_INBOUND_UPLOAD_ENCRYPTION_ENABLED=1
ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED=1
ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED=1
ORKESTR_INBOUND_UPLOAD_PROCESSING_MODE=isolated-worker
```

The API refuses production intake with
`inbound_upload_isolation_contract_required` until its local worker socket,
authentication secret, public verdict key, and exact quarantine roots are
configured. It additionally checks worker health before creating a session or
claiming a scan. The test-only scanner harness requires the test storage
bootstrap and is unavailable in a normal runtime.

The API-side registry contains only age recipients, key status, and the
descriptor HMAC secret. The worker-owned registry contains the owner-scoped age
identities and must be backed up through the worker's approved secret process.
`GET/POST /api/attachment-encryption/inbound/keys` exposes only public key
status. Rotation retires the old key so live sessions can finish; revocation
blocks a release even if a scan was already in progress.

## Shared data path and isolated-worker lifecycle

For each selected file, the browser requests a short-lived session bound to the
authenticated thread and its server-derived owner/tenant, file size, quota,
key version, and expiry. The server returns a versioned HMAC-authenticated age
recipient descriptor. The browser encrypts the descriptor, sanitized metadata,
and streamed bytes before sending raw `application/age` ciphertext. It never
falls back to plaintext while the feature is enabled but not ready.

Ciphertext is stored in an opaque tenant bucket. Valid states are `receiving`,
`quarantined`, `validating`, `scanning`, `ready`, `rejected`, `retryable`,
`cancelled`, and `expired`; scanning is represented by the durable validating
claim while the scanner runs. Repeating the exact same ciphertext for a
session is idempotent. A different retry for that session is rejected as a
conflict.

The API verifies ciphertext checksum, then sends only bounded session metadata,
the ciphertext digest and processing token over an authenticated Unix socket.
The worker decrypts to its private scratch directory, scans inside its Linux
sandbox, and writes a single exact-byte handoff. It returns an Ed25519-signed
clean verdict bound to the session, tenant owner, thread, key/version,
processing token, ciphertext digest/size, plaintext digest/size, and expiry.
The API verifies the signature, all bindings, the exact handoff bytes,
descriptor, authority, key status, and lease immediately before publication.
A clean result is staged outside the agent-visible path; a durable
key/session lease fences the final rename and ready record. A malformed,
misbound, expired, or untrusted verdict never releases plaintext.

Worker restart deletes only its own scratch work. API startup recovery and the
periodic sweep remove only an expired lease whose owner is proven dead. They do
not recursively remove the plaintext directory or steal a slow live scanner.

The HMAC descriptor is a server-side anti-tamper check. Browsers receive it
over the authenticated HTTPS and trusted JavaScript boundary; they cannot
independently verify its HMAC and it must not be represented as browser-key
signing or substitution protection.

The configured limits include ciphertext reservations, actual ciphertext
usage, per-owner/global active session and processing caps, terminal retention,
and stale partial-upload cleanup:

```ini
ORKESTR_INBOUND_UPLOAD_CLEANUP_INTERVAL_MS=300000
ORKESTR_INBOUND_UPLOAD_MAX_FILE_BYTES=26214400
ORKESTR_INBOUND_UPLOAD_MAX_FILES=20
ORKESTR_INBOUND_UPLOAD_MAX_QUARANTINE_BYTES=524288000
ORKESTR_INBOUND_UPLOAD_SESSION_TTL_MS=900000
ORKESTR_INBOUND_UPLOAD_PLAINTEXT_LEASE_MS=1800000
ORKESTR_INBOUND_UPLOAD_PROCESSING_LEASE_MS=180000
ORKESTR_INBOUND_UPLOAD_MAX_SESSIONS_PER_OWNER=100
ORKESTR_INBOUND_UPLOAD_MAX_SESSIONS_GLOBAL=10000
ORKESTR_INBOUND_UPLOAD_MAX_CONCURRENT_PROCESSING_PER_OWNER=2
ORKESTR_INBOUND_UPLOAD_MAX_CONCURRENT_PROCESSING_GLOBAL=20
```

The browser retains only session IDs and per-file state in session storage. A
ready, scanned attachment can be restored after a reload; a non-ready upload
requires reselection of the local source file before its encrypted stream can
be retried. Removing an in-progress file cancels its server session.

## Monitoring and rollback

Monitor the bounded, low-cardinality
`orkestr_inbound_attachment_upload_transitions_total` counter and
`orkestr_inbound_attachment_scan_duration_seconds` histogram. A retryable
worker/scanner outage also creates a watcher alert without filename, path,
owner, or content labels. A missing or unhealthy worker blocks new intake; an
in-flight session remains quarantined and retryable. Rejected attachments are
metrics only and are never passed to an agent.

To stop new encrypted intake, set
`ORKESTR_INBOUND_UPLOAD_INTAKE_PAUSED=1` and restart. Keep both encryption
and required mode enabled; this preserves the plaintext legacy-upload block.
Resume only by setting the pause flag to `0` after the validated isolated
worker contract is available. Do not unset required mode as a rollback
shortcut: that is a security downgrade, not an intake pause.
