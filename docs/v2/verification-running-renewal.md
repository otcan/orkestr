# Independent running-renewal checks

Reviewed source: `1cd249c9dbf74d1418f1c59be4080a61ec1fded4`.
The ordinary Store tests in `v2/acceptance/production_running_renewal.rs`
use public consumed capabilities and opaque renewal issuers only. No private
locator construction, direct SQL writes, provider process or clock override is used.

In an exact disposable source export, copy that file unchanged to
`v2/crates/store-sqlite/tests/independent_running_renewal.rs`.
Use the required host Cargo wrapper with an isolated verification home and target:

```text
test --offline --locked -p orkestr-v2-store-sqlite --test independent_running_renewal -- --test-threads=1
```

Two independently authored tests passed: concurrent independent-pool generation
CAS has one winner; the immutable envelope changes only lease generation/deadline;
old committed receipt replay is preserved while unseen stale observations and
execution callbacks refuse; Stop and session revocation prevent further renewal.
A separate public-parent-capability case preserves active Worker authority after
parent renewal, refuses child extension beyond its original expiry, and fences
that child after parent Stop. Refusal assertions compare full rows of the scoped
execution, lease, delegation, observation, cancellation, control and intake tables
through one read-only transaction. Auth rows are deliberately excluded.

The five supplied Core renewal tests were also independently rerun and passed.
These reruns remain distinct from the two independently authored tests.
No transport transfer, native process continuity, natural-expiry process test,
unknown-commit recovery or production activation is established here. Runtime
must still quiesce pending observations/writes and validate the sealed previous
admission before transferring the same owned process to the new fence.
