# Independent fixture renewal evidence

Candidate: Core `e40572237003bcdefdb805c5be4cd24bce56090c`, PR78.
Verification exported the exact v2 source, retaining its manifest and lock,
then installed the independently authored acceptance modules as store integration
test `independent_transactions`. No schema/source adapter edits or dependency
resolution were made in that candidate workspace.

Install the existing transaction root plus negative/observation modules as
specified in independent-fixture-transaction-evidence.md; additionally install
`v2/acceptance/fixture_renewal.rs` at
`tests/independent_transactions/renewal.rs`. The root now offers a configurable
claim duration; previous cases retain their original 60-second default. New cases
use public 10-second claims so store-clock renewal can extend them without
altering durable deadlines through SQL.

Commands through the required host wrapper, assigned verification target and
owned synthetic home:

```sh
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_transactions
v2-cargo clippy --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_transactions -- -D warnings
v2-cargo fmt -p orkestr-v2-store-sqlite -- --check
```

Actual results: **14 passed, 0 failed, 0 ignored**, 0.73 seconds, including
11 earlier independent transaction cases rerun and **three newly authored renewal
cases**. Strict target clippy, package fmt check and git diff check passed.
Core's six lease tests and aggregate counts are separate author evidence; they
are not counted in these 14 independent cases.

The new checks establish:

- Two actual handles over independently opened pools race the same expected
  generation. Exactly one returns generation2, extending the deadline without
  changing the dispatch fence; the other returns StaleLease.
- Old-generation renewal/new observation, forged historical deadline and changed
  committed body are refused. All columns remain identical across ten scoped
  tables, including fixture_run_leases, in read-only query_only transactions.
- Both original pools close; a new pool opens and reattaches through the original
  live handle. Issued-token history is unchanged. The original old-token Started
  event returns the same event ID, conversation sequence and historical Running
  receipt with duplicate=true. The known renewed token can append the next Failed
  observation at contiguous conversation sequence3; terminal renewal is refused.
- A trigger deliberately aborts insertion of the renewed history token. Every
  durable row remains unchanged. After removing the trigger, legitimate renewal
  succeeds; old reservation consumption is stale and leaves authority intact. The
  original reservation with the issued renewed token consumes exactly once,
  followed by ReconciliationRequired. No replacement verifier or provider I/O.
- Wrong owner, control-only purpose, zero expected generation and wrong expected
  generation preserve the full snapshot; the original valid authority still
  renews successfully afterward.

Snapshot values remain in memory and are not printed. The trigger is bounded
synthetic write-failure injection, not a process crash. Pool reopen with a live
handle is not process recovery or renewal lost-transport-reply acceptance.
Cancellation, lifecycle/effect authority and production dispatch remain pending.
The completed observation SIGKILL slice was not repeated here.

SHA-256:

- Renewal module: `8230c8b574a35291111709fedfbfd4cc600bd5e5b32ed8975c6cbfba760e6dac`.
- Transaction root: `9c2107fafc7fc62809e856c8a59b2246ebad468607d8bd19e156ea6efd02a6d0`.
- Executed binary: `53c2b112ab6ec70c19a86485cc6d4ea052a7d853602af55e39ef016a235bcc30`.

[Independent renewal source review](https://github.com/otcan/orkestr/pull/78#issuecomment-6253009963)
precedes this execution. Authored artifacts require coordinator review/rerun;
no verification-branch CI pass is claimed by these local checks.
