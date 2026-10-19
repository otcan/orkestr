# Schema 39 copy-first upgrade support

Source: `54ad06e408c746b32b67622bce86643d800b1793`; permission HTTP successors change no migration bytes.

Supported populated known-prefix edges are **14, 17, 31, 33, 36, 37, 38 → 39**,
subject to exact schema identification and successful disposable migration rehearsal.
The ordinary Store does not accept arbitrary databases merely claiming these versions.
Every migration row must be a contiguous canonical prefix with matching version,
description, successful flag and SQLx checksum. Tables, triggers and explicit indexes
must match the schema recreated from those exact migrations. Future, changed,
failed or noncanonical prefixes refuse before writable source open.

`preflight::tests::schema36_edges::populated_14_17_31_33_36_37_38_copy_first_edges_to_39_preserve_rows_and_rollback_source`
compares every prior table's original columns and rows, including prefix migration
metadata, upgrades a separate copy, checks maximum version 39, foreign keys and
integrity, reopens it, and verifies original and rollback-copy bytes remain unchanged.
Fixtures have populated message/event/inbox/outbox, completion and payload history.
They do not establish populated execution coverage for every newer ledger or old package.
Newer authority ledgers are explicitly empty in these fixtures, including all four
schema39 automatic-reply tables. Upgrading never imports a permission or send right.

The full preflight suite passed **10/10, zero ignored**, on `32055a685` (5.89 seconds),
using the required locked/offline wrapper. It also tests foreign/empty databases,
orphan sidecars, future WAL-only metadata, changed checksum/schema, and migration
constraint failure without modifying the refused source and sidecars.

Migration39 SHA256:
`afbdb3b02990e47409e5fb2a510a2fef5f1ea28ecb7f6ad79c4e4b4cceff5f76`.
SQLx metadata uses its own embedded checksum, not this SHA256 presentation hash.

Installation must stop writers, preserve the original DB and any WAL consistently,
and upgrade a working copy. Preflight's filesystem copy is not a live-backup or
mount-alias protection facility. Package qualification still requires the matching
sealed binary and Installation's copy-first checks. Never run an old binary on the
upgraded database; rollback restores the untouched original with its old binary.
No current live upgrade or downgrade is authorized by this evidence.
