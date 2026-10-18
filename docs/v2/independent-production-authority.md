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

## Fence and renewal successor

Exact implementation: `4d66e605de5883fbb88356bc4a8957c43a62dbf8`.
The current independent source has four tests; all four passed against this
successor (0 failed, 0 ignored). Historical three-test evidence above remains
at its original implementation pin. Snapshots now also include every issued
production lease-history row.

The added test refuses an unconsumed candidate before callback invocation,
executes a consumed current admission callback, races renewal through two
independent pools (one winner, one StaleLease), and refuses the old envelope.
A current callback returning a synthetic enqueue error preserves all rows;
consumption still cannot issue another capability. Revocation prevents a later
callback. Callback count is asserted explicitly. This tests callback error
propagation, not a real provider transport.

Source review confirms the synchronous fence holds BEGIN IMMEDIATE through
current authority validation and the bounded callback. Renewal cannot revive an
expired context, preserves run identity/purpose/fence, and records the exact
issued generation/deadline atomically. The seven opt-in public checkpoints are
positioned after the relevant writes before commit, or after durable commit
before reply; the admission-before-ack window deliberately precedes inbox ACK.
The checkpoint marker contains only a stage name. No blocking source finding
for this bounded trusted composition. Callback boundedness is a caller contract,
not an enforced execution timeout; a fence is not an inference capability.

Public ordinary process facilities now exist, superseding the earlier facility
request. Independently authored seven-window owned-child SIGKILL/new-process
acceptance remains pending. Core-authored process results do not close that gate.
Lifecycle append/cancellation and live provider execution remain pending.

## Metadata successor

Exact implementation: `d2a1720bad57df5030aaa962c64e8960feff67e5`.
The independent source now includes `production_authority/metadata.rs`; copy that
subdirectory alongside the main integration test in an exact-source export.
No manifest or implementation change is needed. Five tests passed (zero failed
or ignored), including the four earlier ordinary-authority cases.

The metadata case compares complete scoped rows after forged/unbound refusal,
executes a valid setup callback without mutation, consumes the setup grant into
an exact Ready transition, refuses its obsolete setup fence, and attaches the
actual consumed dispatch with durable text preserved. Revocation prevents a
later metadata callback. Trusted synthetic protocol evidence is explicit.
Source review found no blocker for the private grant/transition boundary;
confirmation rechecks authority and generation in its own write transaction.
Same-child transport association and the mandatory subsequent execution fence
remain Runtime responsibilities. No live provider or production activation credit.

Final split-module rerun used a dedicated metadata target subdirectory: five
passed, zero failed/ignored in 0.40 seconds. Two intervening reruns using the
shared target failed at compilation with missing metadata methods after a
concurrent different-source build reused its store artifact; neither was counted
as passing. The clean dedicated-target rebuild resolved that artifact collision
without implementation changes. Package format check passed.
Selected strict clippy also passed on the final split-module source:
`clippy --offline --locked -p orkestr-v2-store-sqlite --test independent_production_authority -- -D warnings`.
