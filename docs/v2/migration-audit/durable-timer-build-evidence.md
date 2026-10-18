# Durable timer compilation and registration evidence

Migration leaf source: `02609673e914759f026a3fb08e2994b40132e05e`.
Admitted disposable base: `473cdd207886ac812f44bcd3836f54ff70f49cfc`.
Only the eight owned `history_import/timers/` files and temporary
`pub mod timers;` registration were added to that archive. All eleven existing
manifest/lock/toolchain hashes remained unchanged. Every other tracked base file
was compared byte-for-byte; the only allowed shared difference was that temporary
registration line.

Executed through the admission wrapper with isolated home/target:

```sh
v2-cargo test --manifest-path "$ARCHIVE/v2/Cargo.toml" --offline --locked \
  -p orkestr-v2-store-sqlite --features fixture-test-controls \
  history_import::timers -- --test-threads=1
v2-cargo clippy --manifest-path "$ARCHIVE/v2/Cargo.toml" --offline --locked \
  -p orkestr-v2-store-sqlite --features fixture-test-controls \
  --all-targets -- -D warnings
```

The leaf **compiled**. The first test run returned exit 101: six passed and two
failed at ordinary `Store::open` during reopen/second-pool setup. The proposal
schema had been installed only by the synthetic test harness; Core correctly
refused it as an unregistered schema. Preflight was not weakened. Strict feature
all-target clippy passed, exit 0. The selected test run filtered 162 other unit
tests; they were **unexecuted**, not credited as passed.

- Binary SHA256: `2697f39c75c9773de5c3fc8a192f67068fc37666d731ae2a1d90e464f9fb1c11`.
- Owned input hash-manifest SHA256: `20d7948b332220a37dcba6b3d9e212e9784f09c6b7c8d9128e174141060b7802`.
  This hashes compact sorted-key JSON mapping repository-relative owned paths to
  SHA256 digests of their exact committed bytes.

Core subsequently published registered successor
`f93bc0f681acf4801e022b259d9695d524944141`: authoritative migration 0027,
module registration and preflight union tests. Migration independently compared
all eight owned leaf files against that committed successor: byte-identical.

**Separately attributed Core execution:** eight of eight timer tests passed,
including ordinary reopen and two-pool claim races; nine preflight and sixteen
terminal selected tests passed; strict feature all-target clippy, formatting and
whitespace checks passed. Core reports actual contiguous migration 26/27/28
coverage without fake predecessors. These are Core's reported execution results,
not a second Migration rerun. Independent registration review remains a gate.

No production timer, credential, native input, provider or external effect was
read or changed. Actual timer-to-runtime dispatch, process-kill windows and
live migration are **unexecuted**. The claim receipt remains inert; a native
admission bridge must atomically validate timer generation and retain Core Stop
fences before any dispatch capability is introduced.
