# Independent timer and stopped-copy review

Reviewed timer implementation `a05f0c87cf5d111396bd1939e64149a4c0bf06f1`
through test-only successor `e62129f92c282862ace1b04e322f5e1d44bb6ee1`,
and Installation `14317e89dfac4673c6b793a2bdbfb257989b34d0`.
No blocking source finding within the reviewed boundaries.

Timer admission uses the shared intake writer in the same immediate transaction
as cadence, claim and provenance. Generic holds fence claims and new execution
authority; cancellation remains available. Current authentication precedes
receipt lookup. Independent execution of the supplied timer filter passed 14/14.

The separately authored `acceptance/production_timer_input.rs` passed one test
covering three control variants. It opens an ordinary Store, admits synthetic
input, reopens, compares exact receipt replay, rejects changed text and a foreign
owner, then disables/stops/rolls back and reopens again. Refusals and revoked
credential replay preserve full rows in twelve timer/intake/execution tables,
read through one read-only transaction. Selected strict clippy passed.
No direct SQL mutations or private authority reconstruction are used.

To reproduce, export the exact timer successor, copy the Rust source into
`crates/store-sqlite/tests/independent_timer_input.rs`, set an owned absolute
`ORKESTR_V2_HOME`, and use the required host wrapper with `test --offline --locked
-p orkestr-v2-store-sqlite --test independent_timer_input`. The wrapper must also
be used for clippy and formatting. No manifest or lock change is needed.

Installation review confirms cooperative stopped-home locking, whole-file copy
verification, successor copy-upgrade/history/FK/checksum preflight before the
original upgrade, and independent old-home rollback preservation. Supplied
focused tests passed 12 local-install plus 9 candidate tests. Separately authored
`acceptance/installation_stopped_copy.py` passed one matrix using real private
home validation: independent DB/WAL/SHM inodes and bytes, nested-destination
refusal, and symlink/FIFO/socket refusal before destination creation. Run it with
`ORKESTR_V2_REVIEW_SOURCE_ROOT` pointing to an exact Installation source export.

These are synthetic Store/copy and source-review results. Actual scheduler,
provider, native process, package schema-28 migration, launcher and full-release
acceptance are not established. Copy safety assumes an exclusively stopped,
cooperative owned instance; it is not protection against concurrent replacement
by an adversarial filesystem writer. No new CI result is claimed.
