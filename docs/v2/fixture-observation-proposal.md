# Fixture observation persistence: narrow decision required

Status: selected for fixture implementation after replay compatibility bf87414f.
Migration 0005 and fixture append implement the rules below; ordinary Store append
remains Unavailable. No dependency, root/lock or production dispatch change.

## Existing blockers and selected direction

`0001_intake.sql` requires a unique non-null `events.message_id`. The event replay
adapter reconstructs every row as owner/http MessageAccepted with MessageId
correlation/causation. `0004_fixture_dispatch.sql` limits fixture run state to
Starting/Blocked. Inserting provider output as another owner message, allocating a
separate journal sequence, or returning a fabricated message receipt is forbidden.
The current append input also contains raw Progress(String), while v5 forbids raw
progress in the metadata journal and no removable payload adapter exists.

Additive migration 0005:

- Preserve canonical `events` IDs, sequence and outbox references. Generalize its
  row to versioned `message_accepted` / `fixture_provider_observed` kinds. Existing
  rows remain message_accepted/v1 unchanged. `message_id` becomes nullable with
  partial uniqueness for message_accepted only. A runtime event has null
  message_id and references its fixture run/session, with optional separate source
  message linkage; never an owner-message projection.
- Add `fixture_observations` as a normalized extension keyed by canonical event ID,
  with run ID, contiguous run-local sequence, versioned semantic digest, bounded
  kind/boolean metadata, input lease/fence snapshot and receipt state. Unique
  (run_id, sequence). It is not another journal: canonical conversation sequence
  allocation, event, outbox, extension row and run projection commit together.
- Extend fixture run states to Starting, Running, AwaitingAcceptance, Failed and
  Blocked. Every historical fixture run holds a unique session occupancy constraint,
  including Failed and Blocked. No acceptance, success, cancellation or release of a
  session for reuse is granted by this slice. Takeover must continue quarantining
  reservations and preserve observation receipts.
- Table rebuilds must preserve all inbound foreign keys (including fixture run
  source-event and inbox admitted-run links). Prove supported-prefix upgrade,
  foreign_key_check and refusal/byte-preservation regressions on copies before
  publishing the migration. Do not edit old migration checksums.

The selected public replay representation is the versioned conversation-event union:
existing MessageAccepted schema 1 plus metadata-only FixtureProviderObserved schema 2 (typed
RunId/SessionId, run sequence, kind, synthetic boolean when applicable). Preserve
existing intake acceptance fixtures. Keep native identity, lease/fence tokens and
raw progress out of DTOs. Current IntakeStore::events returns Vec<EventEnvelope>,
and the selected ConversationEvent union preserves the legacy variant bytes; silently filtering provider events or weakening the current DTO
is not an accepted default. No endpoint is invented by this proposal.

## Proposed fixture-only transition and authority rules

1. Validate input bounds and authenticate caller owner, private handle's immutable
   owner/namespace/key/context identity, and durable run/session/scope/attempt and
   execution-purpose association. Forged principal or envelope cannot obtain a
   duplicate receipt. This authentication is distinct from *current* incarnation,
   lease and fence authority; a previously authorized handle is not a new grant.
2. Look up committed (run, sequence). Compute canonical SHA-256 with the existing
   length-prefixed encoder, domain `fixture-observation-v1`, explicit event tags,
   stable input IDs/generations/sequence and explicit 0/1 synthetic boolean. No
   caller digest, arbitrary JSON ordering or provider text in the journal. Identical
   authenticated replay returns the original event/sequence/state with duplicate
   true even after expiry, takeover or later terminal state. Changed semantic input
   conflicts before current authority checks. This grants no new transition/I/O.
3. Unseen input must match the live handle incarnation, bound readiness and exact
   admission lease/fence, store-clock expiry and consumed DeliveryUnknown dispatch.
   Require the next contiguous sequence starting at one. Admission without consume
   is not evidence of provider dispatch. All writes and checks share one transaction.
4. Starting + Started -> Running. Running + ApprovalRequested stays Running and
   grants no approval. Running + CompletedProposal -> AwaitingAcceptance, preserving
   the synthetic flag as evidence only. Starting/Running + Failed -> Failed (initialization may fail before Started); Starting/Running
   + Lost -> Blocked. Repeated Started or new evidence after terminal/proposal state
   conflicts; committed identical retries still return their original receipts.
5. Progress returns Unavailable without mutation until removable payload ownership
   is implemented/reviewed. Oversized progress is InvalidInput. Stopped returns
   Unavailable until cancellation/control authority exists; never infer Cancelled
   or relabel Completed/Failed/Lost as Stopped. Unseen stale/fenced evidence is an
   explicit refusal; Runtime retains original evidence for reconciliation.
6. Cancellation, renewal, recovery and verified acceptance stay Unavailable; ordinary
   Store/server append and all production starts stay unavailable/blocked.

## Implementation-ready acceptance tests

`fixture_runtime::observation_contract_tests` uses the existing v5 port and actual
fixture admit/reserve/consume setup. The six original pending cases are activated: atomic contiguous receipts and
proposal state; concurrent identical replay/changed-body conflict; authenticated
committed replay after expiry/fence; no event before dispatch; raw progress/Stopped
unavailability; injected projection failure rollback with identical retry. Additional tests verify Failed-before-Started with no reuse, forged envelopes,
ordinary Store unavailability, and exact before/after durable rows including
fixture_observations, conversation sequence, canonical events and outbox.

Prefix upgrades are rehearsed on an expendable DB/WAL copy with foreign keys
enabled before source open. A valid old schema with conflicting historical session
reuse is refused without changing the source or its live WAL/sidecars; it is never
silently rewritten or discarded. Existing checksums and inbound links are tested.

Core tests exercise canonical event/outbox/projection rollback, replay after pool
reopen and known-prefix upgrade. Independent fail-once, reopen, concurrent writer
and lost-ACK acceptance remains Verification/Runtime work. No duplicate
store or runtime-local event authority is needed.
