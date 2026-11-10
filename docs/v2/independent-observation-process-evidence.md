# Independent observation process evidence

Candidate: Core `868113a6746061186bbd70a7d76febb9a93bcbc2`, PR78,
including accepted observation adapter `002270e0` and the feature-only
ObservationBeforeCommit / ObservationAfterCommit checkpoints. The verification
lane exported this exact v2 tree, left its manifest/lock unchanged, and installed
only the independently authored integration test and snapshot helper.

Installation in that candidate workspace:

- `v2/acceptance/fixture_observation_process.rs` becomes store
  `tests/independent_observation_process.rs`.
- `v2/acceptance/fixture_observation_snapshot.rs` becomes store
  `tests/independent_observation_process/snapshot.rs`.

Run through the required shared-host wrapper, with the assigned verification
Cargo target and a fresh owned verification home:

```sh
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_observation_process
v2-cargo clippy --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_observation_process -- -D warnings
v2-cargo fmt -p orkestr-v2-store-sqlite -- --check
```

## Independently authored checks

One parent invokes the ignored child entry four times: one original child and one
fresh exec per checkpoint. Each original child obtains authority through public
bootstrap/readiness/admission/reservation/consume APIs. No provider I/O occurs.
The parent waits for exact checkpoint bytes, calls SIGKILL through that owned
process handle, reaps it and requires signal 9. Cleanup retains ownership of child
handles and removes only the generated synthetic case directory.

A read-only connection with query_only enabled reads all columns in one
transaction across conversations, events, outbox, fixture_observations,
fixture_runs, reasoning_inbox, session_bindings, fixture_supervisors and
fixture_readiness. Snapshots remain in memory. Only length-delimited SHA-256
fingerprints and the synthetic immutable public provider envelope/public
predecessor cross exec boundaries; no private context handle or verifier is
serialized, printed or reconstructed.

- **Before commit:** all nine table fingerprints exactly match the pre-append
  baseline. There is no partial event, observation, outbox or projection update.
- **After commit, before receipt:** one observation and one event/outbox pair
  persist. The prior event/outbox rows match exactly. Every column in the run and
  conversation matches the predicted snapshot except the intended Starting to
  Running state and sequence 1 to 2 updates. All unrelated tables are unchanged.
- Each genuinely fresh process first proves a different PID and unchanged crash
  snapshot after opening the database. Ordinary Store append remains Unavailable;
  the public predecessor ID alone cannot attach to live authority: takeover is
  Busy. Both cases wait concurrently for the real 60-second store deadline, then
  obtain a new authorized exact-predecessor successor through public bootstrap.
- The committed original envelope replays the persisted event ID, run sequence 1,
  conversation sequence 2 and historical Running receipt with duplicate=true.
  Changed Failed/Stopped/Progress bodies conflict. Unseen sequence 2 is Fenced.
  The precommit case has no original receipt and is Fenced after takeover. All
  replay/refusal rows remain exactly unchanged; canonical event sequences are
  respectively [1,2] and [1], with no duplicate or hole.

These are actual process-loss observations followed by **new authorized
predecessor takeover**. They do not resurrect the killed private handle, establish
production execution recovery, test a real network lost ACK, or authorize provider
dispatch. Lifecycle/effect authority and broader acceptance remain pending.

## Execution record

The first independently executed layout passed: 1 parent, 0 failures, 1 ignored
child entry invoked by the parent; 60.29 seconds. Strict target clippy passed.
Final split layout: **1 parent passed, 0 failed, 1 ignored child entry** invoked
four times; **60.20 seconds**, both actual SIGKILL windows covered. Strict target
clippy, wrapper package fmt check and git diff check passed. The ignored child is
an executable entry, not an unexecuted acceptance case.

SHA-256 fingerprints:

- Process test: `c0729685f1696a36a6fb37bc677b500ff56c1a58fc9eee37390f6f0ea8595b1a`.
- Snapshot helper: `7417b4bdae6561638dd85d9001e5884ee0ed71c79329d9055f0ce62477774347`.
- Executed final test binary: `5459ee973307ad7abb1ece678e4f5dc68a32b5b35c9eed5c8d8787d98e93166d`.

Candidate exact-head Rust CI run **39149765927** was independently queried and
reported success at Core 868113a6. This does not execute these newly authored
verification artifacts. Verification-branch CI is pending after publication;
coordinator review/rerun of these authored cases remains required.

Independent bounded source review:
[Core checkpoint review](https://github.com/otcan/orkestr/pull/78#issuecomment-6252974627).
No blocking checkpoint/public-bootstrap finding. Queued UI d076bb75 and runtime
fdab808d source reviews were also completed without bounded blockers:
[UI review](https://github.com/otcan/orkestr/pull/73#issuecomment-6252959445),
[runtime review](https://github.com/otcan/orkestr/pull/76#issuecomment-6252959596).
Neither lane's author-reported execution counts are independent execution here.
