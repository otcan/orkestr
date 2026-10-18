# Authoritative intake SQLite identity and refusal policy

Core owns this policy and the sole store. PR77/archive implementations are read-only
references; their schema, application ID, manifests and lockfile are not adopted.
Status: alias guard is published; identity preflight is authored but unpublished,
uncompiled and unexecuted. This document does not claim safe-refusal acceptance.

## Identity and supported versions

A missing database with no sidecars may be atomically reserved as a new file.
An existing zero-byte file is not a new database and must be refused unchanged.
An existing supported database must be in WAL mode and contain successful SQLx
migration records exactly matching a nonempty contiguous prefix of the binary's
embedded migrations: version, description and checksum. Reject foreign databases,
missing/gapped/failed/unknown/future records, altered checksums and incompatible
schema. Identity also requires the sqlite_schema tables/indexes/triggers/SQLx
metadata to match the schema reconstructed from that exact supported prefix.
A valid earlier prefix may migrate only after identification; migration itself is
an authorized mutation distinct from a refusal. No application ID from an archive
is evidence of intake ownership. This is compatibility identification, not a
cryptographic authenticity or protection from an attacker who controls the home.

## Refusal must precede any source SQLite open

Before opening anything, reject symlink/dangling/nonregular/multiply-linked DB,
WAL, SHM and rollback-journal entries. Require a canonical caller-controlled parent
and no concurrent path replacement. Reject orphan sidecars and unsupported
rollback-journal recovery state. Do not open a writable source pool or set WAL mode
before identity validation. SQLx migration errors alone establish no preservation.

Inspect an expendable main+WAL copy and allow SQLite to rebuild SHM only there.
Never open the source through SQLite even in read-only mode during refusal checks:
read-only connections can still change sidecars. Include committed live-WAL content
in identity, not just the main-file header. Copying a live database and WAL is not
an atomic backup; inconsistent snapshots must fail closed and concurrent migration
is outside the controlled-startup precondition. Clean only owned scratch files.
Do not mutate, checkpoint, remove or normalize source sidecars on refusal.

## Required negative evidence

For each refusal, snapshot source directory entries, DB/WAL/SHM/journal bytes and
alias targets before and after; verify an expected store-startup refusal, not bind
failure or a different startup error. Keep fixture homes and writer/child processes
owned and synthetic. Include existing empty DB, foreign noncolliding tables,
future version, altered schema/checksum, foreign live WAL and future migration
visible solely in uncheckpointed WAL while its source writer remains open.
A main-file-only assertion or closing/checkpointing the writer first is insufficient.
Also prove valid supported-prefix migration/reopen succeeds.

Five identity preflight test functions are currently authored in preserved core
work, not published/executed: existing_empty_foreign_and_orphan_sidecars_are_preserved;
future_changed_checksum_and_altered_schema_are_preserved;
future_migration_only_in_live_wal_is_refused_without_source_writes;
foreign_live_wal_is_refused_without_source_writes;
supported_earlier_migration_prefix_is_identified_then_upgraded.
They are not passing acceptance or a substitute for independent verification.

## Distinct crash gaps

Kill-after-receipt is covered by older intake probes but cannot prove precommit
rollback or committed-before-ACK replay. Those two checkpoints remain pending:
use test-only owned-process handshakes, verify actual SIGKILL, assert no partial
message/event/inbox/outbox/sequence before commit, and original receipt on retry
after committed lost ACK. No production crash endpoint or second journal is allowed.

Core remains LIGHT. Compiling/executing preflight or broader store implementation
requires coordinator scheduling; independent exact-head review remains necessary.
