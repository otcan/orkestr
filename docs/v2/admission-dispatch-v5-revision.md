# V5-native admission and dispatch revision

Status: additive source proposal against exact canonical v5
9880a53e01a964d85c4c94ee5308bb7a8236ab14. Not a rollback to e2de/d4/v4.
Application owns all added types. Contracts, existing ProviderAdmission{run,binding},
u64 authority, CompletedProposal and sole append_provider_event(owner,admission,input)
are unchanged. Native Future+Send remains unchanged; no dependencies are added.

admit_run keeps its four input arguments and atomically creates the run plus inbox
ack. It returns RunAdmissionResult{provider:ProviderAdmission,run_state:RunState,
disposition:AdmissionDisposition,candidate_key:Option<String>}. The provider
snapshot contains authoritative role/owner/scope/session/native binding and state.
FreshCandidate is returned only by insertion, with run Starting, and only after
core validates authorized bound provider namespace/supervisor incarnation, durable
native/protocol readiness, canonical Deep binding, owner/scope/claim, store-clock
lease, dispatch fence and exclusive active turn. Namespace is not a caller-selected
string and native ID alone does not prove readiness. Unimplemented validation is
Unavailable. Existing snapshot state must not be mistaken for a grant.

Identical semantic replay returns Replay, or ReconciliationRequired when dispatch
is unknown, never FreshCandidate or its key. Changed request payload conflicts.
Terminal/active replay cannot restart. The key is unpredictable, one-use and
store-issued only in the insertion response; persist its verifier bound to the
attempt and supervisor incarnation. A caller-created enum/key is not authority.
Lost insertion ACK requires reconciliation rather than reissuing the key.

claim_provider_dispatch verifies and atomically consumes that key to reserve one
attempt under the authorized context. Concurrent claims have one winner. Repeated
requests cannot issue another reservation. consume_provider_dispatch rechecks the
reservation, identity, readiness, store-clock lease/fence and bound incarnation,
then commits DeliveryUnknown before any provider I/O. Only the CAS-winning call
returns DispatchNow. Lost ACK, duplicate consumption and restart return
ReconciliationRequired; never replay DispatchNow. No provider call occurs inside
a transaction. Cancellation/recovery racing consumption use the same authority:
fence wins -> no dispatch; consumption wins -> outcome may remain unknown.

This distinguishes DB insertion, reservation, permission for a single immediate
provider invocation and actual delivery. Neither Execution nor FreshCandidate
alone permits start. A crash before/after invocation is intentionally quarantined;
missing provider Started or local write failure never permits automatic retry.
Explicit reconciled new attempt is required; do not rotate request keys to retry.

ALL high-level runtime starts remain DispatchUnconfirmed pending implemented and
independently tested durable authority. Workers remain unsupported; no second
inbox claim. New dispatch methods default Unavailable; SQLite admission stub stays
Unavailable with return-type-only adjustment. No new schema, durable dispatch
rows, supervisor constructor or provider process is supplied.

Required pending tests: forged scope/role/native/namespace/incarnation/key refusal;
concurrent admission/claim/consumption single winner; active/terminal replay zero
start; changed-body conflict; namespace/readiness/expired lease rejection;
cancel/consume races; lost ACK at all three boundaries; crashes around commit and
provider I/O; restart preserves uncertainty and never starts automatically.
No tests, Cargo or downloads run. Source migration and independent review precede
coordinator-owned lock integration. No root/lock/CI/HTTP fixture changes.
