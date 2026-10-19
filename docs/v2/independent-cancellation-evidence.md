# Independent cancellation and Stopped evidence

Implementation pin: Core `72784259c46c9c350dc392364c4bcd52c5ecabb4`.
Independent source review: PR78 comment 6253213933. Runtime source-only review
of `a952df834cce3d4a75b84a9eaa57e62403b6147e`: PR76 comment 6253280951.
These reviews give no execution credit to Core/Runtime-authored tests.

The verification lane exported exactly this Core v2 tree into its owned isolated
workspace. Every archived implementation, manifest and lock file was byte-compared
with the pin: zero mismatches. Only independent integration-test files were added.
No resolver, dependency, root manifest, store implementation or DTO edits occurred.

Install `fixture_transactions.rs` as store-sqlite `tests/independent_transactions.rs`;
install negative, observations, renewal, cancellation and cancellation_refusals
modules under `tests/independent_transactions/` with those short filenames.
Install `fixture_cancellation_process.rs` as `tests/independent_cancellation_process.rs`
and its snapshot helper as `tests/independent_cancellation_process/snapshot.rs`.
The existing project setup helper gains sibling visibility only, allowing the new
cross-project case to reuse public setup instead of implementing another store.

Use the assigned verification target and fresh owned home, then from pinned v2:

```text
v2-cargo fmt -p orkestr-v2-store-sqlite
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_transactions --test independent_cancellation_process
v2-cargo clippy --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_transactions --test independent_cancellation_process -- -D warnings
v2-cargo fmt -p orkestr-v2-store-sqlite -- --check
```

Here `v2-cargo` means the assigned host wrapper, never direct Cargo. Final
transaction artifact: **21 passed, 0 failed, 0 ignored** (7 cancellation tests,
14 existing independently authored transaction cases), 2.44s after final module
split and extra project/refusal assertions. Process artifact: **1 parent passed,
0 failed, 1 ignored child entry invoked eight times**, 60.47s. Strict Clippy for both selected integration-test
targets, formatting and diff checks passed. The combined command first passed
20 transaction cases plus the process parent; the final transaction-only rerun
after the added project case passed 21. The process artifact was
unchanged by subsequent transaction-only additions.

| Procedure | Independently executed evidence | Remaining limit |
| --- | --- | --- |
| C01 | Candidate/Reserved same-key concurrency; identical original receipt after pool reopen; different key fenced; same request key on two real projects yields distinct scoped receipts and independent replay | No public HTTP cancellation endpoint tested |
| C02 | Four independent-connection consume/cancel races accept only a legal serialization; subsequent consume never DispatchNow; separate cases exercise deterministic cancel-first and consume-first paths | Race scheduling does not guarantee both winners within the four races |
| C03 | Wrong owner, unrelated context/project run, invalid key bounds, real run expiry, forced own-context expiry and Failed/Blocked/AwaitingAcceptance refuse without row mutation; valid key works after malformed requests | Not an exhaustive arbitrary-byte input fuzzer |
| C04 | Execution completion/Stopped and control Started/renew refused; twelve forged control-envelope variants preserve all rows before valid acknowledgement; locator reuse refused after cancel | Runtime fake start/poll/control tests were source-reviewed, not independently executed here; no real provider interruption |
| C05 | Exact Stopped sequence 1 / scope sequence 3, Cancelled receipt; pool reopen and expired predecessor takeover preserve original event ID/receipt; changed replay conflicts, new stale evidence refuses; schemas 3/4 distinct | No session-reuse or production activation credit |
| C06 | Six cancellation failure boundaries (five inserts and final run update), five Stopped boundaries; full-row rollback; legitimate retry sequence 3/provider sequence 1 without gaps | SQL trigger refusal is not SIGKILL |
| C07 | Owned SIGKILL CancelBeforeCommit/CancelAfterCommit, fresh exec, live predecessor Busy then real deadline takeover; rollback or complete request/control/lease/event/outbox commit; immutable receipt replay and changed-key refusal | No network transport acknowledgement was exercised |
| C08 | Owned SIGKILL StoppedBeforeCommit/StoppedAfterCommit; rollback or one committed receipt; fresh exec exact event-ID replay, changed-body Conflict, new stale refusal and canonical contiguous replay | No general process attachment/recovery API was invented |

All twelve tables are captured with every column in one query-only read
transaction; connections close explicitly. Negative assertions compare complete
rows without printing private authority. Process artifacts retain only hashes and
synthetic public immutable envelope/predecessor fields. Committed positive oracles
check unchanged authority/projection rows, exact historical event/outbox/lease
prefixes, new row counts and links, issued purpose, immutable request status,
control state and canonical schema/sequence. Every child is owned by a retained
process handle, receives a cleared environment, and is killed/reaped only after
exact typed marker bytes. Four killed children plus four genuinely new reopen
executions wait the real 60s authority deadline concurrently. No private handle
reconstruction, candidate/reservation locator artifact or artificial takeover
clock was used.

The first process oracle omitted cancellation's intentional reserve_key erasure
and failed; correcting only that expected-row oracle yielded passing runs at
60.51s and the final 60.47s. Two initial wrapper invocations from the repository
root failed before compilation and were corrected to the isolated v2 directory.
No implementation defect or source fix was inferred from these harness mistakes.

Artifact SHA256:

- cancellation.rs: `043d68711915ad127adf6a1883f65a79e635bf4464cbda549ea1dd7588b7c719`
- cancellation_refusals.rs: `5a03000182ee40ebae579f6092a3869ff574f64afbff9650c7fa98e89291762c`
- process.rs: `ce73bf7a382a97c86982d15ea9a9fa575a5f29b6dd377210045a2299e33b90d6`
- snapshot.rs: `3fc38aa347702262c581467cfc765c6b5916631157f9087499e2224727a995cb`
- transaction binary: `95a48321c1e6abec0016cfae433d65b08546694c80188aee6eb8763df579719f`
- process binary: `1b2ff9cd789a00f26c21af07d9b3992eb676e8dd0b7be5c4e8ba2464b70fe900`

Coordinator review/rerun of these authored tests remains pending at publication.
Local evidence is not exact-head CI. Browser/native behavior, real provider stop,
approvals/effects, general recovery, lifecycle completion and production dispatch
remain unaccepted. Ordinary Store and production starts remain blocked.
