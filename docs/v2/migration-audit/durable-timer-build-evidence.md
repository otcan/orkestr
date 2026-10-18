# Durable timer leaf build checkpoint

Exact Core: `256449100fbb4882bb9a6675a3c9714310183fb7`.
Owned source: `87904cb45d28e4d4e087f7226d18a7c516592864` authority subtree and
input helper only. Disposable composition adds only temporary `pub mod authority;`
to the timer module; manifests/lockfiles remain byte-identical with Core.
Fixture-local unnumbered 0033 is not registered migration/upgrade credit.

Executed through required wrapper, isolated lane home/target, offline/locked:

```sh
v2-cargo test --manifest-path "$COMPOSITION/v2/Cargo.toml" --offline --locked \
  -p orkestr-v2-store-sqlite --features fixture-test-controls \
  history_import::timers -- --test-threads=1
v2-cargo clippy --manifest-path "$COMPOSITION/v2/Cargo.toml" --offline --locked \
  -p orkestr-v2-store-sqlite --features fixture-test-controls --all-targets \
  -- -D warnings
```

Compilation succeeded. Tests: **18 PASS, 2 FAIL**, command exit101, 175 filtered;
3.57 seconds. All 14 existing timer tests and four new authority tests passed:
immutable instructions/current owner auth, revoke/held provenance/fresh enable,
terminal Stop, and atomic rollback when authority insertion fails.

Both remaining tests fail at `Store::open` with `StoreError::Invalid`:
weekly reopen and second-pool revoke race. Core's preflight compares the actual
schema against its registered migration prefix; fixture-only 0033 is deliberately
outside that prefix. These tests remain unchanged and unsatisfied. Do not bypass
preflight, fabricate 0031/0032 or call this durable restart/race acceptance.
Core's registered contiguous successor is the precise dependency for rerunning
those two tests. Supervisor issuer/current-machine acceptance remains separately
Core-owned; these leaf tests do not qualify that boundary.

Strict feature all-target Clippy: **PASS**, exit0, 10.14 seconds.
Owned formatting/diff checks: PASS. Test binary SHA256:
`4ab22072810de8e3bc6d0b7e911b3f72c6276015cc46a881a32a57721d030b75`.
Private evidence retains archive and individual source hashes and exact results.
No live timers, production stores, credentials or external dispatch were used.
