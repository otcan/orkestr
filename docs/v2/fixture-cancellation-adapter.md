# Fixture cancellation adapter

This slice implements the selected schema 3 request and schema 4 confirmed
Stopped metadata under the existing application port. It applies only to an
explicitly bootstrapped `FixtureSupervisorStore`. Ordinary `Store` cancellation
and append remain unavailable, and production starts remain blocked. No provider
interrupt, external effect, session reuse, acceptance or recovery is authorized.

## Transactions and receipts

`RuntimeStore::request_cancel(owner, run_id, request_key)` authenticates the bound
owner and immutable supervisor context before looking up a committed receipt.
An identical committed key returns the original receipt, including after expiry,
Stopped or predecessor takeover; this performs no new transition. A different
key after cancellation is fenced. Unseen requests require a live context,
matching incarnation, current unexpired issued lease and exact ready binding.
Failed, Blocked and AwaitingAcceptance refuse new cancellation without writes.

One transaction appends the canonical schema 3 event and public outbox, stores
the immutable cancellation receipt, advances lease generation and dispatch fence,
erases all candidate/reservation locators, and writes a dedicated control outbox.
Candidate/Reserved becomes Cancelled/NotDispatched with a `not_dispatched` control
row. DeliveryUnknown becomes CancelRequested/Unknown with a `pending` control
row. Unknown is not confirmation of a stop. Concurrent consume and cancellation
serialize at the SQLite transaction boundary; no erased locator is reusable.

The exact issued acknowledgement envelope is available through existing public
values, without a private handle constructor:

```rust,ignore
let receipt = handle.request_cancel(&owner, &provider.run.run_id, key).await?;
let control = ProviderAdmission {
    run: receipt.new_fenced_admission.clone(),
    binding: provider.binding.clone(),
};
```

Keep the original provider envelope separately for authenticated historical
execution receipt replay. `control` has purpose CancellationAcknowledgement and
is never execution/start/poll permission. The sole `append_provider_event` accepts
new Stopped only with this exact issued token, current live generation/fence and
CancelRequested state. Its provider sequence is the next contiguous observation
sequence; cancellation requests do not consume provider observation sequence.
Stopped atomically records schema 4 metadata, a Cancelled receipt/projection and
acknowledged control outbox. It does not release the occupied session.

Exact issued-token authentication precedes committed observation lookup.
Identical committed evidence returns its historical receipt before present-day
expiry/fence checks; changed semantic input conflicts. New stale evidence cannot
write or relabel terminal truth. Progress remains unavailable. Cancellation token
renewal and non-Stopped new observations using that token are fenced.

## Migration and independent oracles

`0007_fixture_cancellation.sql` preserves existing migration checksums and copies
canonical events, runs and observations with foreign keys checked. It extends
issued lease history with purpose and dispatch fence, backfilling execution
history, and adds `fixture_cancellations` and `fixture_control_outbox`. There is
no second journal. Public replay returns every canonical row through the selected
schema 1/2/3/4 union; legacy message bytes and fixtures are unchanged.

Full-row transaction snapshots use these twelve tables (all columns and rows,
ordered deterministically, inside one read transaction):

- fixture_supervisors, fixture_readiness, fixture_runs, fixture_observations
- reasoning_inbox, session_bindings, conversations, events, outbox
- fixture_run_leases, fixture_cancellations, fixture_control_outbox

For unchanged ingress/auth authority, independent oracles may additionally record
owners/messages and their existing authentication tables. Close all read handles
explicitly before restart/checkpoint assertions. Public inspection remains scoped
and never exposes verifier or native identity material.

With the opt-in `fixture-test-controls` feature only,
`fixture_arm_checkpoint(stage, fresh_owned_marker)` supports:

| Typed stage | Exact marker | Boundary |
| --- | --- | --- |
| CancelBeforeCommit | cancel-before-commit | All request writes, before COMMIT |
| CancelAfterCommit | cancel-after-commit | Durable COMMIT, before receipt |
| StoppedBeforeCommit | stopped-before-commit | All acknowledgement writes, before COMMIT |
| StoppedAfterCommit | stopped-after-commit | Durable COMMIT, before receipt |

Use an owned child and kill/reap only after exact marker bytes. Hooks time out
without minting authority and do not exist in normal builds. Fresh processes
must use public bootstrap plus the exact expired predecessor, not reconstruct a
private context. A live predecessor remains Busy; process acceptance can wait
its real store-issued deadline. Persist only synthetic public provider envelope
fields and public predecessor incarnation, never context keys, candidate or
reservation locators. A successor can authenticate historical receipt replay but
cannot obtain new predecessor dispatch authority.

Authored tests cover full-row rollback, concurrent cancellation/consume and
completion, forged/expired authority refusal, terminal refusal, historical replay
and populated-prefix upgrade. These are not cancellation SIGKILL acceptance:
independent C01–C08 execution, including both new process windows, remains pending.
