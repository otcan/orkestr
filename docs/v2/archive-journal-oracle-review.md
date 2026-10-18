# Archived journal oracle comparison

## Parent provenance decision

PR #77 is an unmanaged read-only reference. Do not merge it, adopt its workspace
manifest or lockfile, or activate its store/schema. Core-authored ports of useful
behavior and tests must target the sole authoritative store in PR #78. PR #80
preserves the existing base domain metadata journal; that is not adoption of the
PR #77 durable store. Archive worktrees and branches remain untouched.

The matrix below records adoption candidates and exclusions, not authorization
to integrate artifact code wholesale. Historical checkpoints are retained so
review evidence remains attributable to its exact head.


Read-only source review: archive commit
`ef759a48f9d6861b05165f726e2afe2837acaf6e`, compared with core PR #78 at
`d4cf693435378ed232d97df60727ea6e54d9b90b`. The archive branch/worktree is
untouched. No archived store, schema, dependencies or lockfile are integrated.
The reported archive test total was not rerun in this review.

| Archived oracle | PR #78 coverage | Adoption / pending work |
|---|---|---|
| Failed projection insert preserves journal, previous projection and next sequence | Inbox failure covered empty state only | Adapted in Python intake harness: fail events, reasoning_inbox and outbox inserts after accepted history; compare exact durable rows/cursor; same accepted key retains original receipt; next successful admission has no sequence gap. New case is authored, not yet run. |
| Durable original sequence and receipt survives reopen | Five post-receipt SIGKILL admissions with snapshot/history/idempotency checks | Strengthened oracle to require HTTP 202 for every checkpoint and identical durable rows before/after owned-process kill. Awaiting execution. |
| Unrelated, empty existing, future-version or altered databases refused without mutation | Store::open configures WAL and migrations directly | Missing safety contract. Requires separate reviewed identity preflight change and byte/sidecar preservation tests; do not label this acceptance passing. Existing SQLx checksum handling is not proof of non-mutation. |
| Future version present only in uncheckpointed WAL refused without byte changes | No equivalent | Future preflight must observe live WAL with read-only SQLite, not inspect main-file header alone. Snapshot owned DB/WAL/SHM bytes while source connection remains open. Refusal must preserve all files; ordinary read-only connections may touch SHM, so exact-byte assertion remains essential. |
| Symlink database refused | P1 review reproduced database symlink escape despite canonical home | Follow-up adds pre-open refusal for symlink, dangling alias, non-regular and multiply linked DB/WAL/SHM/journal entries. Black-box regression authored; fixed-binary execution remains pending admission/lock integration. This does not supply foreign/future schema identity preflight. |
| Deterministic kill before commit, and after commit before acknowledgement | Only kill after HTTP receipt | Missing. Reuse test-only marker handshake and owned child guard in later reviewed tests; hooks must be absent from production builds. Verify exit signal, no precommit partial rows, postcommit lost-ack retry returns original receipt. No new HTTP control endpoint. |
| Rebuild projections from journal after deleting derived tables; corrupt/unknown records fail closed | Intake event metadata is not an archived full domain journal | Not directly portable. Do not delete authoritative intake rows or claim complete replay reconstruction; define authoritative event payload/reducer contract before adopting this oracle. |
| Concurrent independent store handles and task claim races | Concurrent HTTP ingress uses one server pool | Independent-process/store-handle races remain pending; no task claims implemented. Apply same-key/conflicting-key oracle to existing schema, lease races only after core adapter exists. |
| FULL synchronous and foreign-key policy checked on actual store handle | Configured in SQLx options; WAL checked through separate Python connection | Actual pooled-handle PRAGMA checks remain pending. A PRAGMA on a separate inspection connection cannot prove store-handle settings. |
| Aborting a task with an open write transaction does not poison connection | SQL failure rollback only | Pending adapter-level cancellation test; reuse handshake, abort/join writer and verify subsequent valid admission, not timing sleeps. |

This review introduces one additional Python scenario and stronger existing
oracles only. No store or migration changes. Python syntax and diff checks can
run LIGHT; no Cargo/downloads are permitted while core heavy admission is
released. Runtime-v1 locked compilation is separately blocked on coordinator's
`async-trait` lock update. Previous passing intake evidence remains at
`e2de7312093fdffcd7a8b6111efa546af89bf929` (four Rust tests including seven
Python scenarios); the newly authored eighth Python scenario is not counted as
passing until executed under explicit admission and independently reviewed.

## Artifact PR #77 adoption recommendation

Exact source reviewed: `e4f101e5eb7c0962aa2c02eb1c576e38492e9aa5`.
PR #77 subsequently reports head `9b097f6771ba9d6d7527da4c598579d6411bf1ec`;
that newer head is not covered by this review. Its 25-test report is author
provided offline evidence; this review performs no compilation or test rerun.

Recommendation: adopt applicable implementation techniques and test oracles in
small reviewed changes to PR #78's authoritative intake adapter. Do not merge
`crates/orkestr-store-sqlite` as another active workspace store: its package name
collides with `crates/store-sqlite` (`orkestr-v2-store-sqlite`) and its append/replay
API and metadata schema do not implement authenticated message/inbox admission.
Keep JournalRecord/event-contract-v1 and the in-memory reducer/demo compatible;
there is no automatic metadata-record-to-command authority conversion. The
coordinator owns review sequencing and root/lock serialization; PR #77 itself
is excluded from integration. The UI lane
may reuse isolated fixture source without treating fixture tests as browser/iOS
acceptance. Existing stronger exact-head CI must not be replaced by artifact CI.

| Priority | Concrete adoption into intake | Required oracle / limitation |
|---|---|---|
| First | Copy-based identity preflight before any SQLite source connection or WAL mode change | Refuse unrelated, empty existing, future and altered databases; compare source DB/WAL/SHM bytes and directory entries before/after, including future migration state present only in live WAL. Validate the intake SQLx migration history/checksums and supported schema, not the artifact's application ID/version constants or four-table fingerprint. |
| First | Test-only before-commit and after-commit/before-receipt checkpoints | Owned child, atomic marker handshake, bounded deadline and verified SIGKILL; before commit leaves no message/event/inbox/outbox/sequence changes, lost acknowledgement after commit retries to the original receipt. Hooks absent from production; no control endpoint. |
| Next | Independent handles/process writers | Same-key/same-body returns one receipt; same-key/changed-body has exactly one winner; distinct keys serialize with valid scope order. Existing one-server pool concurrency is not independent-process evidence. |
| Next | Actual pool-connection configuration checks and abort handshake | Check FULL/foreign_keys on store-owned connections, abort an entered write transaction, join the cancelled task, then admit and reopen without partial rows or poisoned connections. A separate inspection connection cannot prove pool policy. |
| Already adapted | Projection-write failure and post-receipt kill oracles | Intake harness now compares prior durable rows under injected events/inbox/outbox failures and requires 202 before kill. Passed at a89392c5; this does not cover the earlier precommit/lost-ack window. |
| Retain separately | Domain transition/replay and strict unknown record cases | Useful for the offline reducer. Do not delete authoritative intake messages as if they were rebuildable projections; runtime event versioning and projection inputs must be defined first. |

The artifact's preflight makes an expendable database/WAL copy because even a
read-only SQLite open can mutate sidecars. Reuse that principle, not an assumption
that copying a live database and WAL is an atomic backup. The adapter must fail
closed on inconsistent copies, retain the owned-directory/no-concurrent-replacement
precondition, and test source preservation. It does not replace the DB/sidecar
symlink and hardlink checks already added in core.

Updated evidence: exact core a89392c52c45612480a67c3394f7f905514bb1cf passed
CI run 39134865286, including nine Rust tests and twelve Python scenarios (four
alias scenarios contain twenty subcases). Independent alias reproduction remains
pending. The old async-trait lock blocker described above was removed at93460326;
it is historical, not the current blocker. Current source reconciliation with
base2c9e1001 awaits coordinator-owned root manifest/lock conflict resolution.
Core heavy admission remains yielded: no new Cargo build/test/download occurred
for this artifact review. Archives were inspected through git objects only.

## Current adoption status under that decision

Core-authored failure-injection, receipt/reopen and alias tests are committed in
PR #78 and have the exact a89392c5 evidence listed above. Before-commit and
committed-before-ACK subprocess kill handshakes, independent writers, and pooled
connection/transaction-abort checks remain pending. They are not covered by the
post-receipt kill test or runtime's in-memory retry tests.

Copy-only intake schema preflight and five refusal/reopen tests are authored in
the preserved core working tree but are unpublished and unexecuted. They cover
foreign/empty/altered/future schemas, future migration state in live WAL and valid
migration-prefix upgrade; no acceptance is claimed. This is an intake-specific
implementation, not adoption of the artifact application ID or schema. Existing
committed alias checks remain independently necessary.

No metadata replay technique may delete authoritative message/inbox rows or grant
effect/approval authority. A durable replay/rebuild oracle is excluded until core
has defined the complete versioned event inputs and projection boundary. No root,
lockfile, dependency, production hook or second store is introduced by this review.
