# Independent dormant recovery process oracle

Pinned implementation: Core `402ac1ad5ab712c353aa17e8d6f3a1fe6ffd61bc`.
This is independently authored acceptance code; coordinator review/rerun remains separate.

In a disposable exact source export, copy `v2/acceptance/recovery_process.rs` to
`v2/crates/store-sqlite/tests/independent_recovery_process.rs` and its support directory
beside that file. Use isolated target/home and the required host wrapper:

```sh
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_recovery_process -- --test-threads=1
v2-cargo clippy --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_recovery_process -- -D warnings
```

Final split-file execution: **1 parent passed, 0 failed, 1 ignored owned-child entry**.
The parent actually invokes that entry: four owned writers are SIGKILLed at restore
and whole-rollback before/after-COMMIT markers; four fresh executable processes reopen
the same synthetic stores. Final parent runtime was 1.75 seconds. Selected strict clippy passed.
No ignored acceptance case is counted as passing.

Read-only single-transaction snapshots capture all tables and columns. Precommit
windows require complete equality; postcommit windows require explicit ledger deltas,
canonical message/provenance/association checks and unchanged non-history tables.
Rollback timestamps and opaque receipt digest are carried into the expected row only
after structural checks; their cryptographic derivation is not independently reproduced.
Fresh-process snapshots match before and after Store open. Lost-receipt retries return
original receipts without duplicate writes; whole rollback does not reactivate original
inactive history. Changed canonical input conflicts without writes. Revoked credentials
refuse fresh and historical operations after reopen without ledger changes.

Source SHA256:

- parent: `1199ef681c2c5c8af63f47c82de48ebc835ab5a07621a88c22efeed695c3bf31`
- support: `9113063e3fbcde727b6ce68adb03b5c04b5c57d282864234ba9f28f06bab0745`
- executed test binary: `5aa98a574dbd1b9dd8a5b45b6d4d1a56d2ebcade12dc45b1f8c88d39dea66c99`

Synthetic data only; no live restore, provider process, production data, transport
lost-ACK, power-loss or OS/disk COMMIT-failure claim. These are actual method checkpoint
SIGKILL tests, distinct from a process exiting before a call or after receipt return.
