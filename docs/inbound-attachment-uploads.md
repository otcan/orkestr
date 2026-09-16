# Browser-encrypted inbound attachments

This capability protects an attachment from the browser until Orkestr has
accepted it into a tenant-scoped ciphertext quarantine. It is separate from
the existing browser-held recipient identities used for outbound downloads.
It does not make an approved attachment secret from the scanner, Orkestr, or
the agent that receives a released attachment.

## Operator prerequisites

Inbound encryption is off by default. Enable it only after installing and
reviewing an approved scanner wrapper on the Orkestr host:

```ini
ORKESTR_INBOUND_UPLOAD_ENCRYPTION_ENABLED=1
ORKESTR_INBOUND_UPLOAD_ENCRYPTION_REQUIRED=1
ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED=1
ORKESTR_INBOUND_UPLOAD_SCANNER_COMMAND=/opt/orkestr/bin/scan-inbound-attachment
ORKESTR_INBOUND_UPLOAD_SCANNER_ARGS=["{file}"]
ORKESTR_INBOUND_UPLOAD_SCANNER_REJECT_EXIT_CODE=10
```

The command must be an absolute path. Its arguments are JSON and must contain
`{file}` exactly where the scanner receives the temporary plaintext lease. Exit
`0` means clean, the configured reject exit code means unsafe, and every other
failure or timeout remains quarantined and retryable. Do not point this at a
placeholder, an unreviewed script, or a scanner configured to upload documents
outside the approved corporate boundary.

The runtime creates a dedicated owner-scoped age identity under
`ORKESTR_HOME/secrets/inbound-attachment-keys.json`. It is 0600 and contains
private identities and the descriptor-signing secret; neither is returned to a
browser or agent. Back up that file only through the approved secret-backup
process. `GET/POST /api/attachment-encryption/inbound/keys` exposes public key
status, rotation, and revocation for the authenticated owner. Rotation retires
the old key so live sessions can finish; revocation blocks further processing
of ciphertext for that key.

## Data path and lifecycle

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

The service verifies ciphertext checksum and age authentication, writes exact
plaintext bytes to a 0600 isolated lease, verifies the signed descriptor and
session binding, then rechecks thread access before and after the scanner. Only
a clean verdict is promoted into the thread's agent-readable attachment path.
The lease is removed in `finally`; startup reconciliation removes abandoned
leases, changes interrupted validation to `retryable`, and removes expired
released plaintext. The server repeats reconciliation at the configured
interval (default five minutes):

```ini
ORKESTR_INBOUND_UPLOAD_CLEANUP_INTERVAL_MS=300000
ORKESTR_INBOUND_UPLOAD_MAX_FILE_BYTES=26214400
ORKESTR_INBOUND_UPLOAD_MAX_FILES=20
ORKESTR_INBOUND_UPLOAD_MAX_QUARANTINE_BYTES=524288000
ORKESTR_INBOUND_UPLOAD_SESSION_TTL_MS=900000
ORKESTR_INBOUND_UPLOAD_PLAINTEXT_LEASE_MS=1800000
```

The browser retains only session IDs and per-file state in session storage. A
ready, scanned attachment can be restored after a reload; a non-ready upload
requires reselection of the local source file before its encrypted stream can
be retried. Removing an in-progress file cancels its server session.

## Monitoring and rollback

Monitor the bounded, low-cardinality
`orkestr_inbound_attachment_upload_transitions_total` counter and
`orkestr_inbound_attachment_scan_duration_seconds` histogram. A retryable
scanner outage also creates a watcher alert without filename, path, owner, or
content labels. Rejected attachments are metrics only and are never passed to
an agent.

To stop new encrypted intake, unset the enabled/required flags and restart.
This preserves ciphertext and does not convert it to a plaintext legacy upload.
When encryption is required, leave the requirement in place until the scanner
and key store are restored; a missing prerequisite must remain a visible 503,
not a fallback path. This feature is not active merely because the code is
present: activation, scanner approval, key-backup custody, and release-train
validation are separate operator responsibilities.
