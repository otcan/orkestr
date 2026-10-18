# Ordinary Fast admission

`Store::admit_fast(credential, &FastAdmissionInput)` now uses the ordinary bound
supervisor transaction. The input contains immutable source MessageId/EventId,
exact Ready Fast SessionId/generation and an idempotency key. It carries no text,
role selection, inbox claim, native identifier or caller authority.

The selected initial policy is one fixed-purpose presentation of exact stored
owner input per source event. It grants no Worker delegation or tool authority.
Source owner/conversation/message/event linkage, current credential, supervisor
namespace/incarnation, native readiness and exact Fast role are validated before
fresh admission. Fast and Deep must have distinct persistent native reservations.
A busy Fast binding cannot claim or acknowledge Deep input; Deep can independently
claim and admit the same owner source while Fast is occupied.

Migration 0022 preserves existing production rows, foreign keys, parent fencing
and revision triggers, and adds the Fast role plus owner/source uniqueness.
Fast runs have zero claim generation and no parent/delegation. A changed request
for an already scheduled source conflicts, including a replacement key. An
identical authenticated replay returns original execution evidence without a
candidate locator, even after dispatch. It cannot restart provider I/O.

Fresh admission returns the existing standard RunAdmissionResult. The normal
reserve/consume path remains mandatory: one reserve winner, then durable
DeliveryUnknown before a private consumed capability carrying exact stored text
can escape. Dispatch/fence/renewal/observation authorization uses authoritative
Fast role and exact binding, not a Deep role substitution. Canonical observations,
lease issuance, cancellation-purpose separation and historical replay use the
same durable machinery. Conversation-level status remains Deep-only; Fast callers
must use authenticated exact-run status.

This source does not activate server scheduling or a provider. Runtime owns the
Fast composition and must retain all real metadata, containment, current-fence
and one-use consumed-capability requirements. Fast terminal continuation setup
and general server-restart recovery are separate reviewed lifecycle work.
