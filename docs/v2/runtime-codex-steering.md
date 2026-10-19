# Sealed Codex steering transport

This Runtime leaf requires Core steering source `1a1f0e683` on its complete
schema-34 ancestry and the read-only issuer getter `6d155881a`. The broker
counterpart is Isolation `2f43c4d018ec913681be0e756f7ef407be4ad89c`.
These are source dependencies, not activation evidence.

Capture `Store::authorize_codex_steering` from the genuine consumed initial
dispatch before moving it into `ReadyCodex::attach`. Once the pump has persisted
Started, call `CodexPump::bind_steering_turn(&Store, &CodexSteeringAuthority)`.
Runtime compares the issuer's full admission with its own and obtains the native
turn from its correlated channel; the caller supplies no native turn identity.

The server authenticates and consumes Core's steering reservation separately.
Pass the resulting `Box<ConsumedSteering>` by value to
`CodexPump::begin_steering`. Under the existing per-run scheduling lock, drive
the normal broker flush and pump step together with
`CodexPump::poll_steering(&Store)`. The latter returns
`SteeringProgress::Pending` or `Acknowledged`. Each nonblocking native suffix
uses Core's dedicated steering fence. Broker preparation and native response
waits occur outside the SQLite transaction.

The immutable frame contains only the capability's request UUID, native thread,
expected turn and text. Preparation does not authorize bytes. A correlated
native acknowledgement is accepted only after the full actual write and is
persisted through Core before further provider polling. It does not complete
the run. Existing-turn progress remains admissible during preparation.

Pending steering prevents lease refresh and session transfer. Stop during an
unresolved steering write quarantines the owned process and preserves durable
uncertainty; it does not reconstruct an interrupt or resend the steering frame.
Malformed, foreign, premature, error or uncertain acknowledgements fail closed.
This leaf does not currently persist native rejection as an acknowledged
rejection. No retry after unknown delivery or restart is provided.

Focused tests exercise channel phase guards and actual sole-writer child bytes
using genuine Store-issued steering capabilities: Stop/revocation before the
first write emits zero bytes; revocation after a seven-byte prefix permits no
suffix. These are synthetic transport tests, not ordinary HTTP or native
provider acceptance. Server registration remains owned by the server factory
lane; Worker and Claude steering remain unavailable.

The validation composition uses full Core `63366a487` plus the exact
`6d155881a` getter, matching existing workspace manifests/lock, broker
`2f43c4d018ec913681be0e756f7ef407be4ad89c`, and the synthetic peer fixture from
`23b334f8a`. The four steering tests and strict Runtime all-target Clippy pass.
The broader Runtime run is **147 passed, 2 failed**: the existing reuse tests'
namespace-local PID cleanup assertions remain unresolved in this lane. This
checkpoint does not claim a green complete union.

Trusted scheduling may sample `CodexPump::steering_readiness()` before advertising
Steer. Its `ready`, `used`, and `remaining` fields describe local transport only;
current Core issuer authorization remains mandatory. The 128-ID budget belongs to
the persistent broker child, survives accepted-turn transfer and lease refresh,
and burns at envelope reservation rather than acknowledgement. Sampling neither
reserves an ID nor resets the budget. Pending writes, observations, tools, steering,
cancellation, terminal or failed channels prevent readiness. An exhausted child
must not advertise a 129th request.

`CodexPump::renew_lease_with_steering(store, &mut renewal, issuer)` consumes the
pump and old issuer, returning `(Authority, CodexPump, CodexSteeringAuthority)`.
It requires Core `7c6787d06`'s sealed `refresh_codex_steering` API. The ordinary
quiescent renewal transfers the same child to its new fence first; only then does
Core validate and consume the exact previous issuer against that transition.
Failure quarantines the child. No native frame, spawn, observation sequence or
steering ID is generated or reset. Call under the existing per-run scheduling
lock; replace the server's authority and issuer together on success. The generic
`renew_lease` remains available when steering is disabled.
