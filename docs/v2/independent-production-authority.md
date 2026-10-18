# Independent ordinary-store authority checkpoint

Reviewed implementation: `7631dea5ef4c4b1d83bcf53d6976c10412594711`.
Independent source: `v2/acceptance/production_authority.rs`, copied unchanged to
`crates/store-sqlite/tests/independent_production_authority.rs` in an isolated
exact-source export. No manifest, lock or implementation edits are required.

The three tests use ordinary `Store::authorize_supervisor`, public machine
session setup, trusted synthetic readiness evidence and real SQLite connections.
They do not invoke fixture authority or reconstruct a private context.

- Concurrent independent handles yield one fresh admission, one reservation and
  one consumed private capability. Its text/message identity match durable intake.
  Closing and reopening the second pool, then reattaching the original live
  authority, gives reconciliation without another capability or locator.
- A forged cancellation-purpose execution envelope refuses without changing any
  scoped row. The legitimate candidate remains usable. Revocation then prevents
  consumption and even identical admission replay without changing scoped rows.
- Browser-prefixed session authority, its bare cookie, malformed machine tokens,
  and unbound execution admission refuse without changing scoped rows.

Snapshots use a dedicated read-only connection, query_only and one transaction,
covering every column of production supervisors/readiness/runs, inbox, bindings,
messages, events, outbox and conversations. Authentication rows are deliberately
excluded; revocation itself legitimately changes that separate table. Verifiers
are compared in memory and never emitted as evidence.

Independent execution through the required host wrapper:

```text
test --offline --locked -p orkestr-v2-store-sqlite --test independent_production_authority
3 passed; 0 failed; 0 ignored
clippy --offline --locked -p orkestr-v2-store-sqlite --test independent_production_authority -- -D warnings
```

The initial and strengthened post-consumption pool-reopen runs both passed.
Selected strict clippy passed. This is bounded storage acceptance, not provider
execution, containment, real protocol confirmation, production cancellation,
renewal, recovery, or release acceptance. Synthetic readiness is an explicit
trusted input here, not evidence of a provider handshake.

Independent process checkpoints remain pending: this implementation exposes
hooks only inside its own unit-test binary. Requested facilities are opt-in
public typed checkpoints after all admission writes/before commit and after
commit/before reply, equivalent reserve/consume windows, and scoped read-only
projections. An independent child must use public machine bootstrap and real
expiry/exact predecessor takeover. Core-authored SIGKILL results remain separate
from independently authored acceptance; pool reopen is not process recovery.
