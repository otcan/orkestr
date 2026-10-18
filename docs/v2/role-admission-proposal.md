# Separate Fast and delegated Worker admission

Status: additive proposal for source review; no role activation or schema writes.
Deep remains the sole consumer of the ordered reasoning inbox. The existing
`admit_run` claim and atomic acknowledgement contract stays unchanged.

## Proposed server-only admission boundary

Add application-owned `RoleAdmissionInput` with exact conversation, binding,
expected binding generation, immutable source MessageId/EventId and request key.
An explicit discriminator selects Fast or Worker with a durable delegation ID.
It contains no owner, native ID, provider namespace, arbitrary prompt, capability
list or supervisor incarnation. The authenticated bound supervisor supplies those
from authoritative storage. Return the existing `RunAdmissionResult`; only the
inserting invocation receives a candidate locator. Reserve/consume still commits
DeliveryUnknown before I/O. Replays never mint a replacement locator.

Fast admission is server-supervisor scheduled against a stored owner-scoped
input and an exact distinct Fast Ready binding with confirmed native readiness.
It does not claim, acknowledge or remove the Deep inbox item. Fast and Deep may
reference the same source input without sharing a session or dispatch authority.

Worker admission additionally requires a durable server-issued delegation. Its
private issuer validates the exact parent RunId, current execution authority,
owner/conversation, immutable source event and selected independent Worker
binding. Browser IDs or provider text cannot mint this record. The delegation
stores the original parent authority identity and explicitly bounded child
purpose; it grants no inherited arbitrary effect capabilities. Replay authenticates
the same principal and semantic input before returning original evidence.

## Required persistence and fencing

Replace the overloaded unique conversation/source-sequence constraint with an
explicit unique Deep claim linkage. Preserve all historical run/source evidence;
Fast/Worker must never manufacture an InboxClaim or impersonate Deep. Distinct
worker bindings retain parent lineage and unique native identity reservations.
One active turn per binding remains mandatory, with the existing terminal
acceptance/cancellation release policy and issued lease history.

A delegation has a durable fence/revocation state. Worker admission, candidate
reservation, consumption, execution callbacks, renewal and new observations must
validate the complete live ancestor chain under the same authority transaction.
Parent cancellation/revocation fences descendant authority atomically before
control delivery. Unknown delivery is retained for reconciliation; neither a
parent stop nor revocation fabricates child Stopped/Succeeded. Historical committed
receipts remain evidence only and cannot release a successor or redispatch.
No role is enabled until these guards and the lease/control propagation tests
are implemented and independently reviewed.

## Coordination and review cases

Runtime/coordinator must select the trusted delegation issuer and parent lifecycle
policy before signatures freeze: whether delegation may precede parent delivery,
and whether parent AwaitingAcceptance retains an already-running child. Until
selected, these conditions refuse rather than implicitly expanding authority.

Verification should cover simultaneous Fast/Deep against one input, independent
Worker bindings, forged/foreign parent/source/binding, changed replay, exact
concurrent single-use issuance, ancestor cancellation versus child consume,
expired/revoked parent versus renewal/callback, reopen/lost ACK with no reissue,
and complete no-write snapshots on every refusal. Existing ordinary production
lease, observation and cancellation tests remain required; fixture identity is
never an alternate authorization path. No shared port, migration, root manifest
or lockfile change is part of this proposal.
