# Durable Codex steering boundary

Schema 34 adds a steering ledger and one immutable native turn correlation per
run. This is a Store boundary, not an activated HTTP or native adapter.

A trusted Runtime captures `authorize_codex_steering(&ConsumedProviderDispatch)`
before moving the genuine Deep capability into attachment. After correlated
native turn-start evidence and durable Running, it calls
`bind_codex_steering_turn(&authority, native_turn_id)`. This issuer grants no
second inference start. Claude and Worker steering are unsupported.

Browser composition passes its original namespaced credential, conversation and
`ExecutionSteeringRequest` to `steer_execution_authenticated`. Origin and CSRF
remain mandatory at the route. The Store authenticates both the current browser
session and bound machine context inside the write transaction before replay.
The exact run/control revision must match; older projection revisions are
allowed, future revisions refuse. Exact key replay returns the original intake
receipt without another reservation. Changed input conflicts.

A supported, ordered request atomically admits canonical input and reserves its
inbox row away from ordinary new-turn claiming. Unsupported steering or an older
eligible input produces an explicit queued disposition, preserving ordinary
order. A pending steering delivery also forces later input to queue. Reserved
inputs never become fresh turns after delivery uncertainty or native rejection.

`consume_codex_steering` commits DeliveryUnknown before returning a private
single-use `ConsumedSteering`. Runtime constructs only text `turn/steer` with
`threadId`, `expectedTurnId`, and the exact stored text. The installed 0.163
TurnSteerParams schema requires those fields; no optional metadata or additional
context is admitted by this slice. Runtime must retain the exact owned-child
identity and match the native response to `request_id()`.

Every actual bounded nonblocking FD suffix must run inside
`with_codex_steering_fence`. No queue, ACK wait or process wait belongs in that
callback. It checks the original current browser session as well as full machine,
run, lease, native binding and Stop authority. Any uncertain callback/COMMIT
poisons the local capability; partial/unknown writes cannot retry after reopen.
A fully written correlated native response can consume the capability through
`acknowledge_codex_steering`; acknowledgement/rejection is neither provider
completion nor owner acceptance. Status reads expose uncertainty, never a new
locator. Lease renewal must quiesce steering; this initial immutable issuer
refuses after a lease generation change rather than reconstructing authority.

Authored Store tests cover exact replay/reopen, queued dispositions, projection
and control refusal, atomic intake rollback, concurrent consume, browser revoke,
Stop between suffixes, native rejection, and actual deferred SQLite COMMIT
failure after callback bytes. No provider launch or HTTP activation is claimed.

Same-child renewal uses `Store::refresh_codex_steering(old_authority,
&RunLeaseTransition) -> Result<CodexSteeringAuthority>`. Runtime calls it only
after quiescent same-process fence transfer. It consumes the old issuer, requires
its full admission to equal the sealed transition's previous admission, and
validates current machine/context, Running execution and the existing native
turn binding under BEGIN IMMEDIATE. It never changes that binding or issues
input/dispatch rights. Stop, revocation, stale transitions and mismatched previous
identity refuse; Runtime quarantines the child on failure. Previously reserved
or consumed steering is not refreshed or reissued by this operation.
