# Independent ordinary owner-acceptance probes

Implementation pin: `e4beb7832afb6b143dc17e8fe079b89ff8c43fdd`.
These independently authored tests use ordinary Store public authorization and
provider APIs with synthetic protocol evidence. They issue no provider I/O and
never reconstruct a private authority context. Owner acceptance uses the unbound
server Store; future HTTP composition must authenticate that owner independently.

Register `acceptance/production_owner_acceptance.rs` as
`crates/store-sqlite/tests/independent_production_owner_acceptance.rs` in a private
exact-source export, with its same-named module directory alongside it. No
manifest, lock, dependency or production source edits are required. These files
are acceptance artifacts, not automatically registered workspace CI tests.

From that export's `v2` directory, using the assigned isolated target/home and
required host wrapper:

```sh
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite \
  --test independent_production_owner_acceptance
v2-cargo clippy --offline --locked -p orkestr-v2-store-sqlite \
  --test independent_production_owner_acceptance -- -D warnings
```

Two tests passed, zero failed/ignored, in 0.42 seconds. This is independent
execution and authorship, distinct from Core's supplied test evidence. The
initial wrapper invocation from the repository root failed before compilation
because that directory has no Cargo.toml; execution above used the correct export.
The executed test binary SHA256 was
`aa01d0a2839e77e4a5c2d7107738bdbb8a32273e61b170d4b8f42b3357a3fb84`.

The race test uses two independently opened Store pools and verifies one identical
receipt. It starts a second turn on the released native binding, consumes its
reservation and records Started before replaying the old owner decision.
Historical decision replay, a changed revision/key, and an obsolete old-run
callback cannot alter any of 16 complete scoped execution tables. The successor
remains Running. Exactly one canonical owner-acceptance event is replayed.

The refusal test checks provider-bound self-acceptance, forged completion/run,
stale revision and foreign owner/conversation, comparing all rows after each
refusal. A SQLite trigger aborts the last decision insert after preceding
release/event/outbox/run writes; the complete original ledger must remain equal.
After removing the trigger, the original decision succeeds; reopening a separate
pool and replaying its receipt leaves all rows unchanged. Read-only snapshots use
query_only and a single transaction, including issued leases, payloads and owner
decisions. Verifier values are never printed.

This is pool concurrency/reopen and deliberate write-failure evidence. Actual
SIGKILL at the owner checkpoints, fresh-exec replay, populated historical-prefix
migration/FK checks, revoked-session HTTP behavior, browser approval interaction,
live provider execution and release activation remain pending independent gates.
No CI pass is inferred from this selected local runner.
