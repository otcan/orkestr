# Independent ordinary cancellation process probes

Implementation pin: `a28308949f8bd48c209d3010afbdb85cd690364a`.
Copy `v2/acceptance/production_cancellation_process.rs` to store-sqlite's test
directory as `independent_production_cancellation_process.rs`, preserving the
`production_cancellation_process/` module directory. Enable the existing
`fixture-test-controls` feature; setup uses ordinary Store authorization, not
fixture bootstrap or reconstructed private authority.

The independently authored parent owns and SIGKILLs four children at public
CancelBeforeCommit, CancelAfterCommit, StoppedBeforeCommit and StoppedAfterCommit
markers. Every child first durably admits, reserves and consumes an ordinary
execution attempt and records Started; Stopped uses the actual issued cancellation
receipt with the original immutable binding. No provider process or inference runs.

A query-only single read transaction captures every column across fourteen scoped
tables, including observations, cancellation/control outboxes, issued lease history,
execution revisions and conversation sequence. Precommit requires complete row
equality. Postcommit checks the journal/outbox prefix plus one linked row and the
specific lease/control/run/binding/revision changes, with all other rows unchanged.
Fresh event identity/timestamp and observation semantic digest are not independently
recomputed; they are carried from the committed rows after structural checks.

A genuinely new executable process reads the same snapshot before Store::open,
then reopens, verifies exact equality, proves live predecessor Busy without writes,
revokes the synthetic machine token and proves Unauthorized without journal changes.
The synthetic token and native-session name are public test values only. Child
handles are retained, bounded waits are explicit, and Drop kills/reaps owned children.

These probes do not yet wait for cancellation-token expiry or retry a committed
Stopped receipt after successor takeover. Same-incarnation terminal-reuse replay is
separately owned by the release-gates helper. No fixture evidence, provider interrupt,
server control route, production activation or broad recovery credit is implied.

Execution results: final strengthened parent PASS, zero failures, one owned-child
entry ignored/invoked by the parent; four kill windows and four fresh execs,
0.71 seconds. Package format check and diff check passed. Initial harness compile
attempts (wrong working directory and a transitive serde dependency assumption)
are failures, not implementation findings or passing evidence. No dependency or
root lock changes were made to address them.

Reproduction commands from the pinned v2 workspace (use the assigned host wrapper,
isolated target/home, and never point at existing application data):

```
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_production_cancellation_process
v2-cargo clippy --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_production_cancellation_process -- -D warnings
v2-cargo fmt -p orkestr-v2-store-sqlite -- --check
```

Final executable SHA256:
`6789d07bcf688585fd6be4c9f50f774bc3c7320e7b3694f48c2d34ee62f88bc5`.
Independent review/rerun of these authored tests and exact pushed-head CI remain
pending; repository CI does not imply execution of this copied acceptance harness.
Final strict all-warnings-denied integration-test clippy passed on the strengthened
source (0.34 seconds after wrapper capacity admission).
