# Terminal session continuation ports

These are sealed Store setup ports, not provider activation. Core
owns the opaque grants, supervisor transitions, migrations and authorization;
server composition owns child shutdown/reaping and Runtime owns protocol setup.
Existing accepted-session setup retains its exact binding checks.

## Confirmed Stop continuation

Bound Store operation:

```rust
async fn authorize_stopped_session_metadata(
    &self, credential: &str, prior_run: &RunId, binding: &Binding,
) -> Result<BoundSessionMetadata>;
```

A current authenticated supervisor may reserve metadata setup once for an exact
terminal cancellation whose canonical Stopped observation and cancellation
receipt agree. The transaction proves owner, conversation, context, incarnation,
provider namespace, native identity, released Ready binding and generation. A
Cancelled receipt for NotDispatched without a Stopped observation is not this
eligibility. CancelRequested, Blocked, unknown transport outcomes and mere
interrupt acknowledgements remain reconciliation-required. No provider start,
lease renewal or dispatch capability comes from this operation.

The durable reservation binds the exact predecessor and terminal event. Its
opaque grant is revalidated at every metadata callback, confirmation and consumed
execution attachment. No generation arithmetic or caller-supplied authority is
accepted. Lost setup grant delivery does not reissue the grant. Confirmation
preserves the native reservation and returns the existing one-way Ready transition.
The server must have fully reaped the prior owned child before requesting setup.

Queued owner inputs remain in their original inbox order. Continuation claims
one still-unacknowledged input and creates a new run through normal admission;
it never retries the stopped run or clears queued follow-ups.

## Accepted terminal restart

Operation on ordinary unbound Store:

```rust
async fn reattach_terminal_supervisor(
    &self, credential: &str, config: ProductionSupervisorConfig,
    prior_run: &RunId,
) -> Result<(Store, BoundSessionMetadata)>;
```

Only exact `ExpiredPredecessor` CAS is eligible. The new credential must be a
current machine session for the same owner; namespace/provider/supervisor key
are trusted server configuration. The transaction proves the named predecessor
is owner-accepted Succeeded, exact native binding is the unchanged released
Ready binding, no intervening run or unknown setup reservation exists, and there
is no unresolved run in that supervisor context. A live predecessor is Busy.
One concurrent successor wins; First never takes over an existing context.

The restart transfers readiness ownership to the new incarnation without
rewriting historical admissions, observations, acceptance or native identity.
It atomically returns one reserved accepted-session metadata grant tied to
that immutable accepted predecessor and the new incarnation. The old context,
old setup grants and all old I/O authority remain fenced. If any unresolved run,
unknown delivery or setup uncertainty exists, ordinary recovery/quarantine is
required instead; this port cannot declare it stopped or accepted.

Other old setup bindings become Lost; only the exact accepted native binding
transfers. The returned grant is private and non-Clone; losing its delivery never
reissues setup. The current-credential checks and actual execution fence still apply
before each real provider write. A trusted child-reaped assertion alone never
grants durable restart authority. Independent process/provider acceptance remains separate from Store tests.

## Graceful terminal shutdown

`bound_store.retire_terminal_supervisor(original_machine_credential, prior_run)`
is a trusted server teardown operation, called only after all owned native
children have been waited/reaped. It accepts no client cleanup assertions, PIDs,
or replacement credentials. Inside one immediate transaction it authenticates
the original credential and exact sealed context, proves the exact Deep run was
owner-accepted with its unreused Ready binding, and refuses any unresolved run
or descendant. A cancelled terminal label without a durable Stopped observation
and acknowledged control outbox is insufficient.

It only sets that exact supervisor lease deadline to zero; receipts, history,
held input and bindings remain unchanged. Repetition before takeover is harmless.
The existing exact expired-predecessor restart CAS may then succeed promptly
without sleeping or changing the clock. Old metadata/execution authority is
expired, and the old handle cannot retire a replacement incarnation. This is not
proof that a native process reaped: server composition must supply that ordering
and independent process tests. This first port covers accepted clean retirement;
unknown delivery, ACK-only cancellation and unaccepted proposals remain refused.

### Graceful provenance (migration 0028)

Deadline zero alone is not graceful-shutdown evidence. Migration 0028 adds an
immutable `production_graceful_retirements` ledger without backfilling legacy
rows. Only sealed terminal retirement records the exact context, incarnation,
supervisor generation, owner-accepted prior run/event and released binding
identity/generation. Discovery and the write-locked predecessor takeover both
require this same record plus deadline zero. Natural expiry and revoked-session
retirement cannot qualify. The marker records the trusted server's retirement
boundary; actual owned-process wait/reap remains the server's responsibility.

0026 (Worker tasks) and 0027 (timers) retain their allocated owners. Execution of
0028 upgrade tests requires their real SQL in a disposable contiguous union;
no placeholder migrations or historical provenance are manufactured. An unused
one-use continuation setup reservation remains non-reissuable; idle restart then
shutdown is not qualified as another automatic restart.
