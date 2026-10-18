# Terminal session continuation ports

This is an implementation proposal, not an enabled setup or restart path. Core
owns the opaque grants, supervisor transitions, migrations and authorization;
server composition owns child shutdown/reaping and Runtime owns protocol setup.
Existing accepted-session setup remains unchanged until this successor is tested.

## Confirmed Stop continuation

Proposed bound Store operation:

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

Proposed operation on ordinary unbound Store:

```rust
async fn reattach_terminal_supervisor(
    &self, credential: &str, config: ProductionSupervisorConfig,
    prior_run: &RunId,
) -> Result<Store>;
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
It then permits one separately reserved accepted-session metadata grant tied to
that immutable accepted predecessor and the new incarnation. The old context,
old setup grants and all old I/O authority remain fenced. If any unresolved run,
unknown delivery or setup uncertainty exists, ordinary recovery/quarantine is
required instead; this port cannot declare it stopped or accepted.

The existing current-credential checks and actual execution fence still apply
before each real provider write. A trusted child-reaped assertion alone never
grants durable restart authority. Proposed ports require independent race,
revocation, stale-predecessor and reopen/no-reissue tests before consumption.
