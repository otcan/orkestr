# Persistent Fast presentation

Fast presents the exact immutable owner input on a distinct Fast native binding.
It does not consume or acknowledge the Deep inbox, delegate Workers, or certify
Deep/Worker output. The ordinary server owns scheduling and native cleanup.

## Source and first dispatch

`bound.next_fast_source(machine_credential, conversation, after_sequence)` returns
`Option<FastSource { message_id, event_id, sequence }>` in a current authenticated
read transaction. The cursor is an exclusive canonical conversation event sequence,
not a Deep claim cursor. Selection skips every source already admitted as Fast
(regardless of terminal state) and every ordinary held input. It returns no text
or authority. Start with zero after restart: the existing Fast run ledger provides
the durable deduplication cursor. Do not persist an advanced cursor before admission
and thereby lose a source after a crash.

Use `FastAdmissionInput` with those IDs and the exact Ready Fast binding generation.
Existing `admit_fast` revalidates source owner/scope, holds, binding, context and
owner-wide source uniqueness inside BEGIN IMMEDIATE. Only FreshCandidate may pass
through reserve/consume, then same-child attachment and actual native-write fences.
Replay and ReconciliationRequired never dispatch. The request key must remain
identical on retry; selecting a different binding/key for an already admitted source
conflicts rather than creating another presentation. Deep claiming stays independent.

## Settling and continuation

Actual Started and CompletedProposal use the ordinary provider observation port.
CompletedProposal remains AwaitingAcceptance. Only the existing authenticated
owner decision for the exact Fast run/completion/revision/key makes it Succeeded
and releases that exact Fast binding. The factory cannot synthesize acceptance
from text, completion, a model assertion or another role's receipt. Until that
owner evidence exists, continuation and retirement refuse. No automatic task
acceptance or new acceptance authority is introduced by this change.

`authorize_accepted_session_metadata(machine_credential, prior_fast_run, ready_fast_binding)`
now supports Fast as well as Deep. It reserves setup once against immutable accepted
history and the same native identity; existing metadata fencing/confirmation and
ReadySessionTransition attachment stay unchanged. A newly consumed Fast capability
must match the exact Ready binding, namespace and incarnation. Worker setup still
requires its separate parent-scoped issuer and cannot use this path.

After every owned native child has been reaped, existing
`retire_terminal_supervisor` can record graceful provenance against an exact
owner-accepted Fast predecessor. `terminal_supervisor_candidate` and
`reattach_terminal_supervisor` preserve that role through exact predecessor CAS and
one-use metadata setup. No new schema is needed. Unknown/ACK-only/unresolved siblings
still refuse; no historical capability is reissued. Reattach restores only the exact
selected predecessor binding and marks other old setup bindings Lost. A multi-role
factory must not treat this as blanket reattachment of Deep and Fast: use distinct
configured supervisor keys/contexts for independently restarted role sessions, or
keep unsupported combined reattachment refused pending a reviewed port.

## Stop and revocation

Existing exact-run authenticated Stop, stable control revision, issued control
receipt, cancellation-purpose suffix fence and genuine Stopped evidence apply to
Fast unchanged. Stop-held input is excluded both at selection and admission; a
selection made before Stop grants nothing afterward. Machine revocation or context
expiry fences setup, admission and I/O. Pre-Stop held inputs never auto-release on
Fast restart, and Fast success never changes Deep inbox acknowledgement or held rows.

Validation exercises real ordinary Store transactions and synthetic native IDs;
server mounting and real provider execution remain separate acceptance work.

## Server acceptance and output boundary

The Store acceptance transaction is intentionally invoked on the ordinary unbound
Store: `accept_execution_authenticated(browser_credential, conversation, request)`.
It rejects supervisor-bound handles and authenticates the current browser session
inside the same transaction before replay or new writes. The exact request already
contains run_id, completion_event_id, revision and request_key. A Fast HTTP owner
route must resolve that exact run as Fast under the authenticated conversation,
then use this operation; do not reuse a Deep-bound ExecutionScope as Fast authority
or broaden a supervisor handle. Its durable row/observation linkage ensures only
that exact Fast run is settled. Root owns deliberate route/registry composition;
this Core change publishes no new endpoint or route activation.

Output uses the existing canonical observation/payload contracts and actual native
proposal. Fast is a presentation of the selected stored input, not an execution
plan approval, Worker task instruction or task-completion certificate. No separate
model-generated success envelope or synthetic completion is accepted. The output's
run role remains Fast, and owner acceptance of it says nothing about Deep/Worker.
Long-running presentation may capture existing `authorize_running_renewal(&cap)`
before transfer and use ordinary quiescent `renew_running`; this never issues input
or dispatch authority, and Stop/revocation/current lease checks remain mandatory.

Required locked/offline wrapper validation: Fast 7/7 passed; broader production
runtime regression 157 passed with two child-entry tests ignored and invoked by
parents (including the actual-process crash parent); final feature-enabled Store
all-target strict Clippy, formatting and diff checks passed. The last added Fast
Stop-selection case was run in the final focused seven-test suite.
