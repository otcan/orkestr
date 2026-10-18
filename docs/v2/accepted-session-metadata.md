# Accepted-turn native continuation setup

`Store::authorize_accepted_session_metadata(credential, &prior_run_id, &ready_binding)`
returns the existing opaque, non-Clone `BoundSessionMetadata`. This is a bound
supervisor operation, initially limited to Deep sessions. It reserves setup once
for the exact durable owner-accepted predecessor, not merely a terminal provider
receipt. The predecessor must be Succeeded, have its canonical acceptance row,
and belong to the current owner/context/incarnation/provider namespace. The full
Ready binding and native identity must match; an intervening turn refuses setup.
The Store proves the accepted generation relationship; callers never perform
generation arithmetic or reset a binding to Starting.

Migration 0021 adds `production_resume_metadata`. A unique predecessor reservation
is durable before the opaque grant is returned. Competing connections have one
winner. Lost grants, confirmed grants and reopen retries never issue replacement
setup authority; uncertain setup requires reconciliation. No inference locator is
issued by this operation. Credential revocation, supervisor expiry/takeover or a
new admission fences all subsequent setup callbacks and confirmation.

Use existing `with_metadata_fence(&grant, bounded_action)` for metadata-only
spawn/enqueue/flush and `confirm_metadata_session(grant, evidence)` after the
trusted adapter validates the correlated persistent session/workspace response.
For continuation, confirmation requires the exact already-reserved native UUID
and binding generation. It atomically consumes the setup reservation, records
confirmation evidence and returns the existing `ReadySessionTransition` without
changing native identity, binding state or generation. Confirmation does not
accept output or create an inference grant.

Runtime must fully stop/reap the previous owned process/readers/writers before
creating a replacement process using this grant. Core cannot infer that process
fact from a completion receipt. Runtime uses its private resume specification
for the exact native UUID; a fresh thread/session response is not continuation.
Only setup commands belong under metadata authority. After durable admission and
reserve/consume of the next turn, attach the one-way transition to the fresh
`ConsumedProviderDispatch`; actual provider writes still require the execution
fence. No serialized grant, public constructor, browser resume route, credential
copy or permissive transport fence is introduced.

Author tests cover accepted setup/native preservation and fresh attachment,
unaccepted/forged/reissued/revoked refusal, admission fencing an old setup grant,
and independent-connection issuance/lost-grant refusal. These are ordinary Store
synthetic tests, not native-provider or actual-process acceptance.
