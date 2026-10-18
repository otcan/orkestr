# Ordinary provider cancellation

This adapter uses the production supervisor authority, never fixture bootstrap.
Migration 0012 adds `production_cancellations` and
`production_control_outbox`, and expands the canonical events and observation
constraints. Read-only complete rollback snapshots must include both new tables,
`production_observations`, run/lease/binding/readiness/supervisor tables, inbox,
conversation sequence, events, outbox and execution revisions.

`RuntimeStore::request_cancel(owner, run, request_key)` commits an idempotent
original receipt, new issued cancellation-purpose lease/fence, erased candidate
and reservation locators, canonical schema 6 event and dedicated control intent
in one immediate transaction. Candidate/reserved runs become Cancelled with
NotDispatched. Consumed DeliveryUnknown runs become CancelRequested with Unknown;
neither request nor transport success confirms interruption. A different request
key or a new cancellation after terminal evidence is Fenced without writes.

For an in-flight request, retain the original immutable `ProviderAdmission.binding`
and replace only its `run` with `CancelReceipt.new_fenced_admission`. This is the
issued control envelope. `Store::with_cancellation_fence` serializes a bounded
nonblocking interrupt transport action against current durable authority. It is
not an execution grant. `with_execution_fence`, reserve and consume reject control
purpose. Only `append_provider_event(owner, control, Stopped)` with the exact
issued lease, fence and next run sequence commits Cancelled, schema 7 stop event,
control acknowledgement and binding release atomically.

Exact authenticated committed observation/request replay returns its historical
receipt before present-day expiry or takeover checks; changed observation bodies
Conflict. New evidence requires live authority. Existing completion or failure is
never rewritten as Stopped. CompletedProposal remains AwaitingAcceptance, never
Succeeded. Progress remains Unavailable pending removable payload storage.

Only Cancelled releases this implementation's session occupancy. A subsequent
turn retains the native session ID and uses the new authoritative binding
generation; concurrent turns remain excluded. Failed, Blocked and
AwaitingAcceptance retain occupancy until separately reviewed recovery or
acceptance policy. Takeover preserves terminal outcomes and unknown cancellation.
Admission replay carries an actually issued historical execution token, no
candidate locator and no replacement dispatch permission.

With `fixture-test-controls` only, public `ProductionCheckpoint` has
CancelBeforeCommit/CancelAfterCommit and StoppedBeforeCommit/StoppedAfterCommit.
Arm via the existing authorized `production_arm_checkpoint` API in an owned
child. Before-commit pauses follow all journal/projection/control writes;
after-commit pauses precede receipt delivery. The normal server never arms these
hooks. Fresh process recovery uses machine authentication plus exact public
predecessor after its real store deadline, never reconstructed private context.

Browser controls still require server owner/CSRF/origin checks and an atomic
conversation expected-revision guard; these store operations do not themselves
activate HTTP Stop or advertise a capability. No real provider execution,
deployment or acceptance gate is implied by adapter tests.
