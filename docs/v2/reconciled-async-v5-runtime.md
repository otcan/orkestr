# Reconciled async v5 runtime review checkpoint

This is ONE proposed review target based on canonical v5
9880a53e01a964d85c4c94ee5308bb7a8236ab14, superseding incompatible PR95 native-v4
as the admission revision review target. Owner/coordinator approval and independent
source migration review still precede root/lock integration; publication is not
merge approval. Do not combine historical d4/v4 signatures or observation policy.

Application RuntimeStore is #[async_trait], Send+Sync with default Send futures,
never ?Send. Application alone pins async-trait=0.1.89 and reexports the attribute
for implementations/spies. IntakeStore is untouched. Existing SQLite runtime impl
gets the same attribute; unimplemented admission remains Unavailable. No other
runtime dependency should be inferred. No root manifest or Cargo.lock is changed.
Owner-directed async-trait requirement is the provenance; no architectural rationale
or compile success is claimed here. Prior historical async-trait clippy findings
remain a validation concern until this exact checkpoint is checked.

V5 types and sole append_provider_event(owner,ProviderAdmission,input) remain.
Authentication against DURABLE owner/run/session/scope/attempt precedes receipt
lookup, never trust an admission's caller-populated owner as authentication.
Identical already-committed semantic evidence returns its original receipt after
expiry/cancellation/fencing with no new event, transition, lease extension or
permission. Changed replay conflicts. Unseen sequence requires live store-clock
lease, fence, purpose, lifecycle and contiguous sequence authority. Persist canonical
semantic input/digest internally; caller digests and arbitrary JSON ordering cannot
grant authority. The exact digest codec still needs an implementation-level freeze
and fixtures before adapter acceptance; no v0 codec is implicitly imported.
Unavailable/Busy retain exact pending input for retry, including possible lost ACK.
StaleLease/Fenced/Expired stop queued delivery but retain bounded original evidence
for reconciliation; Conflict latches a blocker, never ACK. Never fabricate Stopped
or relabel CompletedProposal as success/cancellation. Approval is informational.
Raw progress needs removable payload storage; unavailable storage remains a blocker.

Admission result carries authoritative ProviderAdmission, RunState, disposition
FreshCandidate/Replay/ReconciliationRequired and optional one-use candidate key.
Only insertion can return FreshCandidate/key, after durable supervisor namespace,
incarnation, native/protocol readiness, role, claim and live lease/fence checks.
Fresh DB insertion and Execution alone never authorize provider.start. Candidate
key verifier is stored bound to attempt and supervisor and never reissued on replay.
claim_provider_dispatch atomically validates/consumes key and reserves once;
consume_provider_dispatch commits DeliveryUnknown before I/O, returning DispatchNow
only to the unique CAS-winning call. Duplicate/lost ACK/crash returns reconciliation,
never a replayable dispatch permit. Cancellation/recovery fence the same authority.
No automatic retry after commit/I/O uncertainty; explicit reconciled new attempt.

The two new dispatch methods default Unavailable. Admission, provider append,
binding confirmation, renewal, cancellation, acknowledgement and recovery lack
durable implementation; no dispatch schema, supervisor constructor or live provider
is supplied. Existing binding/claim subset is not proof of runtime acceptance.
ALL runtime high-level starts remain DispatchUnconfirmed. No fixtures or contracts
files change; existing fixtures provide no new dispatch/durable evidence.

No Cargo/downloads/compile/tests performed. Independent review must cover signature
migration, spy cross-principal refusal, lost ACK then expiry/cancel, concurrent
fresh/claim/consume, cancellation races and crash uncertainty. Existing alias P1,
schema identity/refusal, auth-cookie/CSRF and durable adapter gates remain separate.
