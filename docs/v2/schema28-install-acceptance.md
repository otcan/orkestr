# Schema28 installation acceptance preparation

The installation runner consumes an ordinary same-source server/UI paired receipt
and original predecessor packages; it builds nothing. The successor must declare
all migrations 1 through 28. Pass `--new-schema 28 --migrations-dir` pointing at the
exact Core sources when preparing the upgrade. The directory's complete sorted
SQL name/SHA256 inventory must equal the candidate receipt; historical prefix
checksums must match. The runner also derives SQLx SHA384 checksums from those
same verified bytes and checks actual old, migrated, reopened and rollback DBs.

Core has explicitly admitted exact known-checksum14/17→28 inputs. A qualified
paired artifact is still pending. Schema28 requires the exact Core sources;
missing SQLx checksum inputs refuse before any artifact launch. Other future
unadmitted edges remain inspection-only and refuse before opening a database. No intermediate recovery pin, version label or
historical aa8 acceptance substitutes for this successor pair.

Once admitted, the existing populated upgrade sequence retains the untouched old
home and stopped backup. Under the cooperative exclusive lock, whole stopped homes (including DB, WAL and
SHM) are copied with complete regular-file inventory comparison. Before writable
original migration, the successor must upgrade a disposable full-home copy, retain
history, and pass exact schema/checksum, integrity and FK checks. A failed copy
preflight leaves the original package selection/database untouched.

It then verifies successor history/idempotency, exact schema,
reopen, old-executable refusal on a disposable migrated copy, and rollback using
only the untouched predecessor home. Never point the predecessor at the migrated
working database.

The sequence now also takes a stopped successor backup, checks its migrations,
rejects the old-package backup into an empty successor restore target, applies
the same-package successor snapshot dormant, verifies exact DB bytes, checks
launcher activation refusal without mutation, then rolls back to empty data.
Target configuration/bootstrap and both preserved snapshots must remain intact.
Opaque restored authentication is never activated. This is local same-package
recovery; canonical cross-version dormant import and owner rebinding are separate.

Preparation checks executed against the current Core SQL sources: contiguous28
inventory, unchanged historical17 receipt prefix, retained synthetic14/17 SQLx
checksum prefixes, populated history SQL17→28, foreign keys and reopen. These do
not execute an original or successor server and do not qualify SQLx startup,
populated provider-run backfills, browser, providers, CI or deployment. Actual
paired native/Docker upgrade/restore acceptance remains unexecuted until handoff.
