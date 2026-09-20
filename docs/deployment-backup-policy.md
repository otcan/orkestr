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

The archive scope is unchanged: it retains workspaces and uncommitted work.
Do not exclude entire worktrees to save space. File-based live archives can
observe concurrent writes; they are not a transaction-consistent database backup
or an off-host disaster-recovery copy. Plan restore drills and database-specific
backup coverage separately. This policy changes frequency, not those guarantees.
