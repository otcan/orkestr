# Explicit owner acceptance (contract checkpoint)

Schema 9 `execution_accepted` is a separate canonical owner decision. Existing
schema 1–8 serialized variants remain unchanged. `ExecutionAcceptanceRequest`
identifies the run, exact durable completion EventId, expected conversation
revision and idempotency key. Owner and conversation come from the authenticated
server context, never a provider-supplied identity. Browser writes require the
existing cookie, CSRF and Origin protections. No HTTP route is activated here.

The proposed Store operation is `accept_execution(owner, conversation, request)`
returning `ExecutionAcceptanceReceipt`. This is an owner operation, not a
RuntimeStore provider method. The adapter must authenticate owner/scope before
looking up a historical decision. Identical committed replay returns its original
receipt without changing the current binding, even after another turn starts.
Changed input under the same owner/conversation/key conflicts.

A new decision requires the exact run in AwaitingAcceptance, its exact durable
CompletedProposal event, the expected current conversation revision, and the
still-occupied matching binding. Unknown, Failed, Blocked, stale-revision or
superseded authority refuses without writes. One atomic transaction records the
owner event, outbox and receipt, changes only that run to Succeeded and releases
only its binding for a subsequent turn. Provider completion never self-accepts.
No provider sequence, native reference, lease, fence or dispatch locator is
published in this owner event. The completion EventId is explicit typed linkage;
no message causation is manufactured.

`v2/fixtures/execution-accepted.json` illustrates the replay event.
Receipt schema 1 carries both completion and acceptance EventIds, original
requested revision and committed revision, with outcome `succeeded`. Consumers
must validate variant/schema and identity, preserve atomic replay cursors and
recognize the `execution_accepted` SSE name. The initial contract checkpoint implemented DTOs only; the adapter below was
added after the contract and matching consumer source compatibility review.
Independent adapter review and HTTP activation remain separate gates.

## Ordinary Store adapter

`Store::accept_execution(&OwnerId, &ConversationId,
&ExecutionAcceptanceRequest) -> Result<ExecutionAcceptanceReceipt>` is implemented
on the ordinary, unbound server Store. Supervisor-bound handles are rejected;
there is no provider acceptance operation. As with intake and payload owner
operations, the trusted HTTP caller must derive owner from its live authenticated
session and enforce CSRF/Origin, never accept an owner identifier from the body.
No acceptance HTTP endpoint is activated by this patch.

Migration 0015 adds `production_acceptances` and schema9 canonical events. It
extends run state to Succeeded and releases occupancy for only Cancelled or
Succeeded. Failed/Blocked remain occupied. Acceptance checks exact completion
membership, revision, Busy binding generation/native identity/provider namespace
and unchanged readiness incarnation. It does not grant provider I/O or change
DeliveryUnknown evidence. The original completion receipt remains
AwaitingAcceptance on replay; the separate owner decision establishes Succeeded.

The transaction atomically records event/outbox/decision receipt and advances the
matching binding to Ready at a new generation. Historical acceptance replay does
not inspect or update the successor binding. Admission/status decode Succeeded,
allowing a subsequent turn on the same persistent native session. Neither
successful provider completion nor a Stop request implicitly accepts output.

Opt-in `fixture-test-controls` exposes `AcceptanceBeforeCommit` and
`AcceptanceAfterCommit` through
`production_arm_owner_checkpoint(owner, conversation, stage, fresh_marker)` on an
unbound Store only. Other checkpoint kinds are rejected by this owner facility.
It adds no normal-build hook or HTTP endpoint. Independent owned children can
create a normal authorized provider turn, persist public request IDs, arm the
owner checkpoint, then be killed. Fresh processes use their ordinary authenticated
owner path to replay the decision; no supervisor reconstruction or expiry wait is
needed for this owner action. Full-row oracles include `production_acceptances`
in addition to existing run/lease/binding/inbox/event/outbox/control/payload tables.

Authored coverage includes independent-pool acceptance races, same-native next
turn and immutable old receipt replay, foreign/forged/stale/terminal refusal,
provider-handle refusal and injected persistence rollback. The actual-process
parent SIGKILLs two owned writers at the two acceptance boundaries and starts two
fresh replay processes. This is Store acceptance evidence, not HTTP/browser or
provider-execution acceptance. Populated historical-prefix upgrade and independent
acceptance review remain separate gates.

## Credential-bearing HTTP boundary

HTTP composition must use `Store::accept_execution_authenticated(credential,
conversation, request)`. It derives owner from the exact stored credential and
rechecks its owner, expiry and revocation under the same immediate transaction
as the decision or historical receipt lookup. Revocation committed before that
transaction therefore refuses both fresh writes and receipt delivery. A
concurrent revocation serializes with the decision; it cannot retroactively undo
an already committed acceptance. Browser composition still enforces CSRF/Origin
and passes the exact namespaced credential used by session authentication.

The earlier `accept_execution(owner, ...)` remains a trusted internal Store
operation: a cached OwnerId is not proof of current authentication. It must not
be exposed directly by an HTTP handler. No acceptance endpoint is activated here.
