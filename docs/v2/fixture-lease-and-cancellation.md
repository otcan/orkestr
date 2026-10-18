# Fixture lease renewal and the cancellation boundary

The existing v5 `RuntimeStore::renew_lease(&RunAdmission, expected_generation)`
port is implemented only on an authorized `FixtureSupervisorStore`. Ordinary
`Store` remains unavailable. No provider is started or interrupted.

Renewal authenticates the bound owner/context/incarnation, exact run/scope/
session/role/native identity/attempt/purpose/fence and an issued lease token.
Only live Execution authority on Starting or Running is eligible, with the
current Deep busy binding and confirmed fixture readiness still matching.
The store clock sets the extension to at most 60 seconds and never beyond the
supervisor deadline. If no extension is possible, Busy leaves authority intact.
Renewal does not renew the supervisor itself. Expired authority cannot renew.

A successful short transaction inserts the next lease generation. Independent
contenders with the same expected generation have one winner; the loser is
StaleLease. Renewal has no caller request key: a lost renewal reply cannot be
replayed as another successful renewal. It grants no replacement candidate or
reservation. A caller with a known renewed execution token can update its
existing provider envelope; existing one-use dispatch verifiers remain required.

Additive migration 0006 stores issued lease generations and exact deadlines in
`fixture_run_leases`, backfilling existing admissions. Original fixture run
admissions remain immutable. Dispatch requires the latest generation. Observation
receipt authentication accepts an exact historical issued token, then performs
committed semantic dedup before checking live authority. Thus an old committed
observation retains its original receipt after renewal, but a new old-generation
observation is stale. A forged historical deadline is not an issued token.
No renewal event or native identity is added to the public metadata stream.
Full-row refusal and process snapshots include the new issued-token table;
known-prefix migration checks verify backfilled tokens and preserved foreign keys.

## Cancellation decisions still required

The existing signatures are sufficient for calling cancellation:
`request_cancel(owner, run_id, request_key) -> CancelReceipt`, followed by the
sole `append_provider_event(owner, ProviderAdmission, ProviderEventInput)` with
Stopped under CancellationAcknowledgement purpose. Their implementation remains
Unavailable. The selected schema/replay shape cannot currently express them:

- `fixture_runs.state` excludes CancelRequested and Cancelled.
- `fixture_observations.kind` and the public schema-2 observation enum exclude
  Stopped; receipt states exclude Cancelled.
- There is no canonical cancellation-request event or durable control outbox.
  The existing outbox references public canonical events, not interrupt commands.
- The contract does not specify whether an already Failed/Blocked/
  AwaitingAcceptance run returns an unchanged cancellation receipt or refuses a
  new cancellation request. Neither option may overwrite terminal truth.

Proposed smallest additive follow-up, requiring explicit event-policy selection:

1. Add a distinct metadata-only FixtureCancellationRequested replay variant and
   a separate fixture control outbox referencing its canonical event. Use the
   same owner/conversation sequence transaction; retain existing serialized event
   variants. No native IDs, control locators, generations or raw progress leak.
2. Persist an owner/context-scoped idempotent cancellation request and its exact
   original receipt. Fence lease/dispatch authority and erase outstanding
   candidate/reservation verifiers atomically before exposing any control token.
   Candidate/Reserved may become Cancelled with NotDispatched; DeliveryUnknown
   becomes CancelRequested with Unknown, never confirmed stopped.
3. Add Stopped metadata and Cancelled receipt support as an explicit replay
   extension. Only a live, exactly issued CancellationAcknowledgement envelope
   at the new fence can move CancelRequested to Cancelled. Execution envelopes,
   forged cancellation purposes, old fences and failed interruptions cannot.
4. Conservatively refuse a new cancel after Failed/Blocked/AwaitingAcceptance
   with Fenced and no writes; replay an already committed same-principal cancel
   request using its stored receipt. Do not relabel prior CompletedProposal,
   Failed or Lost evidence. This terminal policy needs selection before code.
5. Retain occupied bindings after cancellation; reuse, recovery, success and
   acceptance remain unavailable. Lease renewal must reject control-only tokens.

Implementation-ready follow-up tests: consume versus cancel CAS winner; pending
reservation cannot consume after cancellation; cancel request lost-ACK replay
and changed-key scope isolation; old execution completion refusal with no state
rewrite; cancellation-token Started/renew/dispatch refusal; exact Stopped receipt
replay and changed-body conflict; control outbox/event/fence rollback together;
terminal-before-cancel snapshot equality; process loss before/after cancel COMMIT.
These are pending cases, not passing acceptance. No shared port or root dependency
change is proposed, and cancellation is not partially activated by renewal.

## Selected cancellation replay checkpoint

The selected additive DTO is `FixtureCancellationRequestedEnvelope`, exposed
through `ConversationEvent::FixtureCancellationRequested`, with schema version
3 and SSE name `fixture_cancellation_requested`. The JSON fixture is
`v2/fixtures/fixture-cancellation-requested.json`. Legacy schema-1 message and
schema-2 provider observation bytes are unchanged. The envelope retains explicit
source message/event linkage and canonical conversation sequence. Its payload
contains only typed run/session IDs and `outcome`: `not_dispatched` for a
Candidate/Reserved cancellation committed before delivery, or `unknown` for a
DeliveryUnknown cancellation request. Unknown never confirms cancellation.
Neither outcome authorizes execution or interruption. Unknown fields, wrong
variant/schema combinations and invented confirmed outcomes are rejected.

This checkpoint defines replay compatibility only. No cancellation rows, control
outbox, Stopped observation, public endpoint or provider activation is implemented
by this DTO change. The dedicated control outbox will remain separate from public
metadata and contain no replay-visible control authority. Stopped acknowledgement
and its receipt-state extension will accompany the adapter slice under the exact
issued control-purpose/new-fence rule; no binding reuse is granted.

## Stopped acknowledgement compatibility checkpoint

`FixtureProviderStoppedEnvelope` is a distinct schema-4 replay variant, SSE name
`fixture_provider_stopped`, with fixture `v2/fixtures/fixture-provider-stopped.json`.
Its metadata payload contains typed run/session IDs, positive contiguous provider
run sequence and singleton `receipt_state: cancelled`. It carries the same public
canonical scope/event/time and explicit source linkage as the other fixture
variants. Schema-2 `FixtureObservationKind` remains unchanged and rejects Stopped;
schema-3 remains cancellation-request metadata only. No native identity, token,
lease/fence or locator is serialized. The run sequence belongs to the existing
provider stream, not a second acknowledgement stream.

The existing application `ProviderEvent::Stopped` input and
`ProviderEventReceipt { state: RunState::Cancelled, ... }` already represent this
operation; no port or receipt struct change is required. The future migration
must add `cancel_requested`/`cancelled` run projections and `cancelled` persisted
observation receipts, while preserving historical receipt values. Only an exact
issued `CancellationAcknowledgement` admission with the new cancellation fence
may append a new Stopped acknowledgement from CancelRequested. An execution token,
a request receipt or interrupt return cannot acknowledge cancellation. Authenticated
identical committed replay retains its original receipt before current authority
checks; changed replay conflicts. Failed/Blocked/AwaitingAcceptance evidence is
never rewritten as Stopped or successful cancellation. Sessions remain occupied.

This commit publishes DTO/fixture compatibility only. Request cancellation,
Stopped persistence, migration and control outbox remain unavailable pending
matching UI consumer and independent source compatibility review. No existing
schema/fixture bytes, shared port signatures or production gates are changed.
