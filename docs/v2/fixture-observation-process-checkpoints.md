# Fixture observation process checkpoints

The opt-in `fixture-test-controls` feature adds two typed `FixtureCheckpoint`
variants to the existing `fixture_arm_checkpoint` API:

- `ObservationBeforeCommit`: marker `observation-before-commit`, after canonical
  event, observation, outbox, sequence and run projection writes, before COMMIT.
- `ObservationAfterCommit`: marker `observation-after-commit`, after successful
  COMMIT, before receipt delivery.

Markers contain only the stage name. A parent owns, kills and reaps the child;
there is no production endpoint or normal-build hook. The bounded checkpoint
wait is not a commit acknowledgement.

The store unit process harness initializes the first child through public fixture
bootstrap, readiness, admission and dispatch APIs. Its private temporary artifact
contains a synthetic immutable provider envelope and public predecessor
incarnation, without context identifiers, candidate/reservation locators or
verifiers. It does not reconstruct a private supervisor handle.

After actual SIGKILL, the parent takes read-only complete-row snapshots. A fresh
exec checks the same snapshot, ordinary Store refusal and live-predecessor Busy,
then waits for the real store deadline before exact-predecessor takeover. Both
crash windows run concurrently, so the real deadline costs about one minute.
Committed identical Started replay returns the original event/sequence and
historical Running receipt without another transition. Changed replay conflicts;
unseen evidence is fenced. Before-commit loss rolls all writes back and cannot
mint replacement observation authority after takeover. Complete-row equality
checks cover supervisors, readiness, runs, observations, inbox, bindings,
conversation sequence, events and outbox. Pool reopening and deliberate
in-process reply dropping are separate weaker tests.

Run using the required repository Cargo wrapper, with an isolated target/home:
`test --locked --offline -p orkestr-v2-store-sqlite --features fixture-test-controls`.
The ignored `process_child` test is an entry point invoked by the parent test,
not pending acceptance. Production starts and unimplemented lifecycle methods
remain blocked.
