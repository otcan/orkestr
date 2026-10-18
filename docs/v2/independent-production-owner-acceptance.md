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

Additional execution on the same implementation pin passed three parents (zero
failures, one invoked child entry) in 0.60 seconds, including two actual owned
SIGKILL windows and two fresh executable reopens. The process oracle checks exact
16-table rollback before commit and explicit expected field/row deltas after
commit, then original receipt replay and changed-request refusal. Its binary
SHA256 was `a82f2b26c0ce60a700586345bd8af836b49f31ddf2298e8b360f40a54fa4a871`.

The separate `production_acceptance_upgrade.rs` runner passed one test on two
owned synthetic populated migration-14 databases in 1.26 seconds. It copies
DB/sidecars before opening, requires clean foreign keys before/after migration15,
and compares every prior application row and migration checksum, permitting only
the new migration record and empty acceptance table. Register it as an ordinary
Store integration test and supply the owned source directories through
`ORKESTR_V2_PREFIX14_SOURCES` (platform path-list syntax). An initial oracle failed
because SQLite JSON rejects BLOB checksums; the corrected oracle encodes BLOBs as
hex without changing the database. Final binary SHA256 was
`a80d57af1058433340a2adb602415b3da160732d6e73b074834e1e96d99b6bdc`.
Failed-upgrade refusal, revoked-session HTTP behavior, browser approval interaction,
live provider execution and release activation remain separate pending gates.
No CI pass is inferred from this selected local runner.

Current-session successor `f6a211fbbd4316fd648455b68927abf4721e81c0`
was exported separately and independently ran three ordinary tests successfully
(zero failed/ignored, 2.73 seconds). The additional public-API matrix checks
revoked and expired namespaced browser credentials before fresh acceptance and
before historical receipt replay, through original and newly opened pools.
Every refusal leaves all 16 execution ledger tables equal. Expiry is deliberate
synthetic auth-row mutation; auth contents are never printed. This proves
current-session refusal, not a deterministic interleaving after preliminary
lookup: that transaction-entry race awaits a public synchronization facility.
HTTP route/session/CSRF composition remains pending. One initial registration
attempt failed before compilation because the test had not yet been copied into
the export; the completed run above used the registered unchanged test.

At exact successor `ec38c13b962bccbd7c3a64e5d32a2c27e33fc83e`, two selected
authentication tests passed (zero failed/ignored; four unrelated tests filtered)
in 1.51 seconds. The new public checkpoint test deterministically reaches the
post-authentication/pre-transaction marker, then commits revocation or synthetic
expiry through an independent connection before releasing the writer. Fresh
acceptance and already-committed receipt replay both return Unauthorized, with
all 16 execution tables unchanged. An initial test compile required making the
armed Store binding mutable; no implementation change was needed. Removing only
the transaction-time credential guard in the private export caused this oracle
to fail (zero passed, one failed), establishing that preliminary authentication
alone cannot satisfy it. The mutation was restored immediately afterward. This
is task/pool interleaving, not additional SIGKILL or HTTP evidence.
