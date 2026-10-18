# Independent dormant history process acceptance

`v2/acceptance/history_process.rs` is test-only integration source, never a server
route or another import writer. It uses ordinary authenticated Store methods,
owned child handles and private synthetic homes. No provider or live data is used.

Exact source pair: Core `62b8f2d90e4796885817083efbb9c21f501a1614` plus Migration
`602df8e267164fad6d987506b6a26e22360730e5` history_import subtree. Export Core to
an owned disposable checkout, replace only that subtree from Migration, and copy
the independent source unchanged to
`v2/crates/store-sqlite/tests/independent_history_process.rs`. No manifest, lock,
writer implementation or authority constructor is changed. Set isolated absolute
`ORKESTR_V2_HOME` and dedicated `CARGO_TARGET_DIR`; from `v2`, use the assigned
host wrapper:

```sh
"$V2_CARGO" test --offline --locked -p orkestr-v2-store-sqlite \
  --features fixture-test-controls --test independent_history_process
"$V2_CARGO" clippy --offline --locked -p orkestr-v2-store-sqlite \
  --features fixture-test-controls --test independent_history_process -- -D warnings
```

The parent covers import/rollback before COMMIT and after COMMIT before receipt.
Each case waits for exact synced marker bytes, sends actual SIGKILL, reaps its own
child, reads a query-only consistent transaction, then starts a genuinely new
executable for open/retry/auth checks. The ignored child entry is invoked eight
times by the parent, not an unexecuted acceptance case.

The oracle snapshots every existing application table and column, encoding BLOBs
as hex without printing values. Real ordinary intake makes messages/events/inbox/
outbox nonempty. Every non-history table must remain identical, including any
existing approval/timer/native/authority tables. This does not invent absent
tables or claim a populated provider/approval/timer baseline.

Precommit rows equal the prior snapshot exactly. Postcommit rollback changes only
active/revision/rollback timestamp; the fresh timestamp is validated positive
before use in the exact expected row. Postcommit import has one batch/two messages,
with exact owner/namespace/source conversation/fingerprint/watermark and ordered
Unicode readback. Lost-receipt retry preserves every row. After rollback, original
import receipt replay does not reactivate current history. Changed content
conflicts; revocation and pool reopen refuse import/rollback with unchanged rows.

Final strengthened run: **1 parent passed, 0 failed, 1 owned-child entry ignored**,
1.39 seconds, four SIGKILL windows and four fresh-exec retries. Selected strict
clippy passed. Earlier supplied tests and compile failures are separate evidence.
No live import, provider, OS/disk COMMIT-failure, browser, cutover or release
acceptance is implied.
