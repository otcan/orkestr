# Recovery transaction checkpoint handoff

Prerequisite Core registration and checkpoint API:
`26fa660fa90ca8b203653894b6949758492edef1`.
The owned source change adds only four feature-gated method calls in
`history_import/recovery_restore.rs` and `history_import/recovery_rollback.rs`:

- `recovery-restore-before-commit`: both inert ledgers, outer receipt and child
  associations written and verified, immediately before COMMIT.
- `recovery-restore-after-commit`: COMMIT completed, immediately before receipt.
- `recovery-rollback-before-commit`: both child states and outer rollback receipt
  written and verified, immediately before COMMIT.
- `recovery-rollback-after-commit`: COMMIT completed, immediately before receipt.

Each call uses the existing `production_checkpoint` facility, maps errors to
`HistoryError::Unavailable`, and compiles only under `fixture-test-controls`.
There is no new callback, writer, schema, shared registration, environment switch
or runtime path. Fresh restore's replay return is unchanged; rollback's shared
return path also handles validated identical replay. Verification must use a fresh
restore/rollback operation to exercise writes at the intended crash boundary.

Core's `production_arm_history_checkpoint` accepts the four corresponding enum
variants with the current owner credential. Verification owns process termination
and the independent read-only whole-ledger oracle. Before-COMMIT kills must leave
neither partial children nor partial outer provenance; after-COMMIT kills must
retain complete state and permit immutable receipt replay. Rollback kills must
preserve an atomic pair of child states and the corresponding outer state.

Executed on the new call sites: rustfmt check and diff check PASS. Compilation,
marker execution, SIGKILL tests and recovery acceptance are **unexecuted** by
Migration for this successor. Earlier 14/14 tests and strict clippy at the exact
pre-hook source remain separately attributed in recovery20-build-evidence.md.
No live restore or production data is involved in this handoff.
