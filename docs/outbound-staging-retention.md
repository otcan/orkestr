# Outbound staging journal retention

This operator tool quarantines old, completed, unreferenced **journals**, not
attachment files. It is not disk-space reclamation for uploads, snapshots,
encrypted objects, backups, or delivery payloads. No automatic schedule or
production activation is installed.

## Safety contract

- Explicit canonical thread and owner; no cross-owner sweep.
- JSON/SQLite on one host only. Postgres/distributed retention is refused.
- Minimum age seven days; bounded batches with a continuation cursor.
- Acquire message, outbox, then journal locks. Normal repository writes and
  delivery mutations use the same locks. Stale history writes restore an exact
  quarantined journal before publishing its reference again.
- Inventory includes canonical and legacy message records plus every outbox
  source-message reference, including terminal and uncertain delivery states.
  Incomplete journals stay in place. Malformed inventory fails closed.
- Quarantine uses no-clobber hard links, directory fsync, then unlink. An
  interrupted link-before-unlink resumes only for the identical inode. Conflicts
  and unsafe symlinks stop the operation. Attachment bytes are never deleted.
- Retained journals have no purge deadline. Removing them requires a separate
  reviewed retention protocol; do not delete them manually as routine cleanup.

## Operator procedure

Run from a release checkout with an explicitly selected private `ORKESTR_HOME`:

```sh
node scripts/outbound-staging-retention.mjs --thread example-thread --owner example-owner
```

The default reports candidates only; it does not relocate journals. Storage
initialization may create locks or perform existing lazy JSON-to-SQLite migration.
Use `--limit` (1–1000) and the returned `nextCursor` as `--after` to inspect
subsequent batches. Keep reports private.

Before applying, coordinate **all** writers: deploy this revision everywhere
sharing the stores, drain/restart old processes, and enable
`ORKESTR_STAGING_RETENTION_FENCED=1` consistently. The flag is an operator
attestation, not automatic proof that old writers are absent. Never enable it
only for the cleanup command. Verify the exact owner/thread and review the dry
run before using:

```sh
node scripts/outbound-staging-retention.mjs --thread example-thread --owner example-owner --apply --confirm-quarantine example-thread
```

Quarantined journals are under the same scoped directory in `retained/`.
Normal fenced message writes restore exact matches automatically. For an
operational rollback, stop retention first and restore only validated matching
journals under the same message/outbox/journal locks; do not bulk-copy files into
a live store. Never downgrade writers while quarantine remains active without
first reconciling retained references. No message resend is part of retention.
