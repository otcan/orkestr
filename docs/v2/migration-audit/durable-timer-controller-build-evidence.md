# Durable controller isolated build evidence

Core: `e3857e9b79c4b030cc0c3e36e4b5a74e9aefce39`.
Owned source: `32e3d0f9e092597b9aebd9e6ad170b6b47c64be1`.
The disposable Core archive received only `timer_http/durable.rs` and
`durable_tests.rs`, plus temporary server lib declaration
`#[path = "timer_http/durable.rs"] pub mod durable_timer_controller;`.
Manifests and lockfile were byte-compared against Core and remained unchanged.
No shared HTTP/auth/router/lifecycle composition was included.

Required build wrapper commands (from disposable workspace):

```sh
v2-cargo test --offline --locked -p orkestr-v2-server durable_timer_controller -- --test-threads=1
v2-cargo clippy --offline --locked -p orkestr-v2-server --features orkestr-v2-store-sqlite/fixture-test-controls --all-targets -- -D warnings
```

Results: four selected tests passed; strict feature all-target server lint,
owned Rust format and diff checks passed. Initial admitted df96 source also
passed all four tests but emitted one unused fixture-variable warning. The
successor changes only that binding; its rerun passed warning-free (2.70s).
The synthetic tests cover bounded cursor wrap, ordinary Store refusal and joined
shutdown, weekly authority across creator logout/Store reopen plus machine
revocation, and actual Store-clock once-due admission without duplication after
controller restart. No live store, provider, credential or timer was accessed.

SHA256:

- `durable.rs`: `f36cc1dde3c5aaba836dc2c602ed2448482385778d58beb8270de5121191db66`
- `durable_tests.rs`: `40b90e278ff8c02dd7fa0cefd52ce0498c670633c2a1613cd8e2132a1b2d922a`
- executed server lib test binary: `2c326d0b345bbd20a9b25e8f5a885f1df3ad1de6c3cecd88f7c740413eff924e`

Deep still owns durable owner-enable/read mapping, trusted supervisor bootstrap,
shared mounting and joined lifecycle. Existing mounted ephemeral behavior is
separate. Mounted durable HTTP, ordinary binary restart, process crash and
provider execution acceptance are **unexecuted** here; these unit/integration
checks do not qualify them. No schema or shared registration changes are needed
from this worker.
