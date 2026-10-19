# Deployment backup policy

Code rollback and state recovery are different operations. Hosts may opt into
`ORKESTR_DEPLOY_BACKUP_POLICY=scheduled` in their persistent deployment env file.
Code-only releases then reuse the newest completed nonempty state archive,
which must be no older than 36 hours. A missing/stale archive blocks activation;
it does not silently disable protection or start a surprise full backup.
Unconfigured hosts keep the conservative `always` policy.

Run `orkestr-deploy backup` nightly with a host scheduler. It uses the same state
scope, exclusions, compressor, permissions and deployment lock as release
backups, but does not build, switch code, restart services or send notifications.
Set lock-busy exit status to 75 for the scheduler and retry later. Alert on a
failed run or an archive older than the allowed freshness window. Existing
deploy retention is count-based (one to three completed archives); at least one
completed archive survives even if its replacement fails. In-progress archives
have a hidden `.part` suffix and never count as completed. Host cleanup timers
must share the lock and must not age-delete the last recovery point.

For migrations, schema changes, destructive maintenance, key changes, or any
release that changes durable state, use `install --state-change`. This forces
a fresh backup regardless of scheduled policy or a legacy environment default
of zero, and rejects `--no-backup`. A missing state source blocks the operation.
Operators must classify state-changing releases during review; this flag does
not automatically discover arbitrary application migrations. `--backup` also
forces a one-off archive for otherwise code-only releases.

The archive scope retains workspaces and uncommitted work. Do not exclude entire
worktrees to save space. Before archiving, Python 3 (with SQLite support) prepares
private SQLite backup-API snapshots of the canonical stores defined in
`packages/storage/src/paths.js`, `packages/core/src/agent-job-store.js` and
`packages/storage/src/connector-inbox.js`: threads, thread-messages, agent-jobs,
thread-resource-policy, connector-outbox, broker-instances and data/connector-inbox.
Missing databases are not created. Configured database overrides must remain
inside the state home; symlink paths, nonregular databases/companions and
colliding canonical paths fail closed. Agent-job and connector-inbox overrides
use their application resolvers' trimming rules; the other overrides remain
literal. SQLite may maintain reader locks/shared memory; the helper does not query application rows or write source database pages.

Each included database is read through SQLite (including its committed WAL),
checked with `integrity_check`, hashed and staged as a standalone database at its
original relative restore path. Live canonical DB/WAL/SHM/journal members are
excluded from tar; staged copies replace only the database members. Existing
exclusions also suppress canonical snapshots and continue to apply to caches;
uploads and other application/user files retain their existing scope. The reserved
root `.orkestr-sqlite-snapshots.json` records format, completion, original relative
paths, byte counts and SHA256 digests. After restore, that historical receipt may
remain in state. A bounded regular, non-hardlinked receipt with the exact known
format, completion, unique relative paths, valid digests and matching byte totals
is recognized and excluded from the live tree; exactly one fresh receipt is added
from private staging. The source receipt is never modified or deleted. Its old
digests are historical, not a requirement that databases remain unchanged after
restore. Arbitrary/invalid metadata, duplicate keys, symlinks, FIFOs and other
nonregular paths fail closed without replacement. Both generated and accepted
receipts are limited to 64 KiB. Canonical member exclusions are anchored literal
paths, separate from existing user wildcard patterns; unrelated nested project
files and names containing wildcard characters are preserved. Staging uses a
disjoint archive-member root, including when the home is named `snapshot-overlay`.
Format recognition is not publisher authentication or current-state attestation.
The operator-shell restore plan in `packages/core/src/state-backups.js` extracts
the archive without consuming metadata; this handling supports that unchanged
layout. Restore the ordinary state tree with services stopped into a fresh destination; never overlay these databases onto stale WAL/SHM.

The total snapshot deadline defaults to 300 seconds and staged database bytes to
8 GiB. Positive integer overrides are `ORKESTR_DEPLOY_SQLITE_TIMEOUT_SECONDS` and
`ORKESTR_DEPLOY_SQLITE_MAX_BYTES`. The deadline includes reads, integrity checks
and hashing; the file-size limit and progress checks bound database output.
Allow disk headroom for both staging and the compressed archive. No fallback to
raw canonical databases occurs on timeout, corruption, unsupported configuration,
byte exhaustion or snapshot failure: the command fails before archive publication.
The existing compressor/archive verification gates still apply. EXIT/INT/TERM/HUP
cleanup removes this invocation's staging and partial only, retaining the last
completed archive. Service managers should signal the complete process group;
a shell-only signal may wait for its bounded child. SIGKILL/power loss cannot run
traps and may leave a private staging directory/partial for reviewed cleanup.

These are **per-database** consistent snapshots taken at different times. There
is no cross-store writer barrier; other SQLite files and ordinary live files are
not covered by this canonical snapshot guarantee. This is not a global
transactional application restore, cross-store consistency proof or off-host
recovery qualification. Plan separate coordinated restore drills.

Synthetic regression command:
`node --test test/deploy-backup-policy.test.js test/deploy-sqlite-backup.test.js`.
It exercises a concurrent WAL writer, restored integrity/value bounds, digest and
restore layout, cache exclusions with preserved uploads, explicit database
exclusions, malformed database/invalid location/byte/deadline refusal, prior
archive retention and interrupted process-group cleanup. A second oracle exercises
actual archive→restore→backup→restore, preserved prior metadata, all canonical resolvers,
padded overrides, literal wildcard names, nested same-basename files and the
staging-name collision. It checks byte-identical source DB/WAL files and refusal
without publication for arbitrary/reserved metadata paths. No production archive,
provider data or installed service is used.
