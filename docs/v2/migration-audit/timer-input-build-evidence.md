# Registered timer-input isolated verification

Executed against an exact disposable archive of Core
`a05f0c87cf5d111396bd1939e64149a4c0bf06f1`, applying only the two-file test
patch from `aa2a719b70b162934fa92d8a37783ad057beb4d5`. Core's expanded tests,
shared eligibility filters, authoritative migration 0029, manifests, lock and
all other tracked base files were preserved byte-for-byte.

Patch SHA256: `f775fdf3f4359df2db1b49209c371af48d6872107a3d689b6b1c2239bd5e6144`.
Executed unit-test binary SHA256:
`b0e432fa4ab98612c64573340c8ffa42b40d7de36f1bb8fc132158eb9d23c341`.

Using the required capacity-limited wrapper with isolated home/target and
unchanged dependencies:

```sh
v2-cargo test --manifest-path "$CHECKOUT/v2/Cargo.toml" --offline --locked \
  -p orkestr-v2-store-sqlite --features fixture-test-controls \
  history_import::timers -- --test-threads=1
v2-cargo clippy --manifest-path "$CHECKOUT/v2/Cargo.toml" --offline --locked \
  -p orkestr-v2-store-sqlite --features fixture-test-controls --all-targets -- -D warnings
```

Results: 14 timer tests PASS, 0 failures, 167 unit tests filtered; integration
test binaries had no matching selected tests. Strict feature all-target clippy
PASS. Owned rustfmt check and `git diff --check` PASS. No result is transferred
from Core's separate run.

Coverage includes provenance-insert failure after native writes rolling back
native rows, scope sequence, claim and cadence, followed by successful retry;
revoked credentials refusing persisted receipt replay; ordinary dedupe/content
conflict; inert enable refusal; disable fencing candidate/reserved/consumed
execution with zero callback; dormant source import; and concurrent claim/reopen
coverage inherited unchanged from the exact candidate.

This is isolated synthetic Store verification, not live timer activation,
external dispatch, HTTP/UI acceptance, process crash acceptance, or full-release
parity. Actual Deep Stop/new-generation and bridge-specific two-pool/reopen
acceptance remain separate unexecuted extensions. Deep owns HTTP registration.
