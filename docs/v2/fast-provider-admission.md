# Fast provider admission checkpoint

`Store::admit_fast(credential, &FastAdmissionInput) -> Result<RunAdmissionResult>`
is the exported server-supervisor seam. The input has exact typed source
MessageId/EventId, Fast binding SessionId, expected binding generation and request
key. Owner, conversation, provider/namespace/incarnation, role and text are resolved
from authenticated durable state, never caller text or role. Initial policy is
fixed-purpose presentation of the exact stored owner input, with no delegated tool
or Worker authority. Runtime owns the new server `fast_execution` subtree.

This checkpoint explicitly returns Unavailable after current bound-context auth;
it creates no run or dispatch locator. It does not enable Fast under Deep disguise.
The next durable adapter must prove the exact Fast Ready binding and distinct
persistent native identity in the same provider namespace, immutable source event
ownership/scope, one active turn, and idempotency before issuing one fresh candidate.
Source replay must never reissue authority. Standard reserve/consume, metadata,
execution fences, renewals and observations require explicit Fast lineage support.

Fast consumes no Deep InboxClaim, never acknowledges Deep ingress and cannot block
its independent ordered claim. Worker grants and subordinate offline Python grants
are not accepted. Runtime may implement its caller against these symbols while
Core completes the separate lineage migration and refusal/race/reopen tests. No
native provider activation, readiness or Fast end-to-end acceptance is claimed.
