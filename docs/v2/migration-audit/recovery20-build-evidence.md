# Schema-20 recovery execution evidence

Exact Core candidate: `bcd93cd3595b14eab817b65b97b56876afe37e26`.
Exact Migration source: `d585a74c1676cb086bbb734260e2ed68220ec494`.

An admitted disposable git archive of Core received only the committed
`v2/crates/store-sqlite/src/history_import/` subtree. Temporary internal sibling
registration added recovery_export (public), recovery_codec, recovery_capture,
recovery_restore, recovery_rollback and test-only recovery_store_tests in that
archive. The worker repository and Core shared registration were not changed.
All 11 manifest, lock and toolchain file hashes stayed equal to the Core archive;
all compiled owned source hashes stayed equal to the recorded build input.

Migration subtree `git archive` SHA256:
`d253f004cbf64d10e661b22dd083e17552058012fde2abe3db75a256fdf7b992`.
Feature-enabled unit-test binary SHA256:
`62b2406c6f9107683f35f7c9613ee372a7e2cabe1a20cadb74b7357fea514e73`.
The private receipt retains per-file hashes, temporary registration, isolated
build locations, terminal results and the exact binary path. No private state or
production source data was consumed.

With a fresh isolated home and target, the policy wrapper admitted one slot under
load, four jobs. Both commands exited zero:

```sh
v2-cargo test --manifest-path "$DISPOSABLE/v2/Cargo.toml" --offline --locked \
  -p orkestr-v2-store-sqlite --features fixture-test-controls history_import \
  -- --test-threads=1
v2-cargo clippy --manifest-path "$DISPOSABLE/v2/Cargo.toml" --offline --locked \
  -p orkestr-v2-store-sqlite --features fixture-test-controls --all-targets \
  -- -D warnings
```

Selected tests: **14 passed, zero failed**, 119 other unit tests filtered out,
2.36 seconds terminal test execution. This includes five new actual Store tests
and nine earlier history tests; the earlier group includes a child-process harness
entry. Separate Core integration test binaries were built but their tests were
filtered out by this selection and receive no execution credit here. Strict
feature-enabled all-target clippy passed in 23.52 seconds. No owned source fixes
were needed. Python migration suite remains **115/115 PASS**; rustfmt and diff
checks pass.

The five new Store tests establish these bounded synthetic observations:

- Complete inactive-original restore, reopen, immutable original receipt replay
  after whole-bundle rollback, both children inactive, and individual rollback hold.
- Wrong/currently revoked auth refusal; changed source, swapped targets, occupied
  namespaces and changed rollback replay refusal.
- A trigger abort on the second child rolls back both history batches and leaves
  no outer receipt or association.
- Independently changed child activity or tampered text holds the whole rollback;
  the other child and outer revision remain unchanged.
- Explicit recovery-only export returns verified inactive text and a synthetic
  native delta at one Store cut; ordinary inactive history reads remain empty.

Core registration and independent review are pending. Recovery-method SIGKILL
before/after commit, delivery-time revocation under a concurrent writer, storage
failure/power loss and production recovery are **unexecuted**. Existing abrupt-exit
history tests do not grant those recovery-method crash claims. The Python JSON
collector envelope and Rust binary Store bundle remain separate contracts; a
validated serialization adapter has not been implemented. No native runnable
admissions, sessions, credentials, routes, timers or external effects are restored.
