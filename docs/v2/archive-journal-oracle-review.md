# Archived journal oracle comparison

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
| Symlink database refused | Home is canonicalized; database file is not explicitly refused | Pending separate identity/path policy and tests. Never exercise against another lane or live data. |
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
