# Runtime event extension decision

Status: contract decision only; migration, adapter and acceptance tests pending.
This does not close the isolation blocker or authorize broader heavy work.

## Provenance and authority

Reconciles runtime proposal 42a0dce6fc618e0f1578c13e32c103c31395ca3b,
core agreement e2de7312093fdffcd7a8b6111efa546af89bf929, and
[runtime adapter proposal](runtime-adapter-port-proposal.md) preserved in the
combined candidate. The latter is a proposal, not a second store contract.
Later shared-port revisions require explicit source reconciliation; this decision
does not silently substitute one signature set for another.

Core owns every schema, migration, store transaction and shared event contract.
Runtime owns adapters and supervision, with no SQLite/JSON journal of its own.
Application ports use native fn returning impl Future + Send; no async-trait is
required. Native provider/session/turn references stay application-only.

## Existing schema and additive migration

Do not edit applied 0001_intake.sql. Its events.message_id NOT NULL UNIQUE allows
only one event per source message. Its owner-only message actor is an ingress
invariant, not permission to represent provider output as owner input.

A subsequent core migration must define a versioned event kind and typed aggregate
identity, allow nullable source-message correlation for lifecycle events, and
replace unconditional message uniqueness with partial uniqueness for accepted
message events. MessageAccepted must still require its source message. Every event
must retain validated owner/conversation association; nullable correlation must
not weaken scope isolation. Existing intake receipt/event replay remains compatible
through an explicitly versioned DTO; do not expose runtime rows through the current
message-specific EventEnvelope as if every row were MessageAccepted.

Runtime events use the SAME canonical conversation sequence allocation and outbox.
Observation deduplication, legal transition/projection, sequence allocation and
outbox insertion must commit atomically. Rollback leaves no sequence gap, event,
projection or handoff fragment. No separate journal/sequence authority is allowed.

## Payload and authority boundaries

Lifecycle metadata is typed: Started, ProgressRef, ApprovalRequested,
CompletedProposal (including synthetic provenance), Failed, Stopped and Lost.
Raw provider transcripts, native identifiers and arbitrary provider JSON are not
metadata journal payloads. Progress persistence requires scoped removable payload
storage and an authorized reference; until implemented, defer it explicitly rather
than fabricate evidence. Application progress input is bounded to 8192 UTF-8 bytes.

ApprovalRequested grants no approval or effect authority. CompletedProposal means
AwaitingAcceptance, never Succeeded; verified acceptance is separate. A racing
cancel may not rewrite CompletedProposal/Failed/Lost into Stopped. Authenticate
owner/run/session before dedup: an identical committed semantic input returns its
original receipt after expiry/fence advancement without a new transition. Changed
replay conflicts. New contiguous observations require current lease/fence and legal
state. Core computes canonical digests. Unavailable retains exact pending input;
stale/fenced refusal is not acknowledgement and requires explicit reconciliation.

## Required acceptance before integration

- Existing intake fixtures/receipts and owner-only ingress remain valid.
- Interleaved ingress/lifecycle events share unique ordered scope sequences and outbox.
- Cross-owner/scope/session references fail without writes.
- Injected event/projection/outbox failure rolls back the entire transaction.
- Identical lost-ACK replay returns original receipt; changed input conflicts;
  new stale/fenced sequences cannot transition state or dispatch effects.
- Versioned replay distinguishes message/lifecycle events; no owner spoofing,
  transcript retention or automatic provider/effect restart is introduced.

No acceptance above is claimed by this document. Isolation fix execution/review
remains a separate prerequisite. Heavy store/migration work requires rescheduling.
