# Claude requested and observed native identity

`Store::initialize_claude_session(BoundSessionMetadata,
ClaudeProcessInitialization)` consumes a trusted metadata grant after the adapter
validates the correlated initialize response. The response proves process protocol
readiness only. Its typed input contains the launcher's requested canonical nonnil
UUID, protocol version and initialization event key. It is not
`NativeSessionConfirmation`, and does not claim that the provider echoed a UUID.

The returned `ReadySessionTransition` retains the original metadata identity for
one-way attachment to the exact consumed dispatch. Here Ready means eligible for
the first dispatch under the reserved identity. `Binding.native_session_id` is a
reserved locator, not proof of observed identity. Migration 0030 records this
explicitly per session/binding generation with NULL observation fields. Fresh
native reservation and this record commit atomically. Accepted or confirmed-Stopped
continuation consumes the existing one-use resume grant and preserves its UUID;
each new setup generation still requires a new actual observation.

After actual inference consumption, the trusted adapter calls
`Store::observe_claude_session(&ProviderAdmission, native_session_id,
source_event_key)` with the genuine matching system/init. Current authenticated
supervisor, full issued execution envelope, live lease/fence, consumed dispatch,
context/incarnation, reserved UUID and setup generation are checked in the write
transaction. Matching concurrent or identical retries are idempotent; changed
observation keys conflict and foreign UUIDs fence without writes. This operation
issues no dispatch capability. Its retry requires current authority, unlike
historical canonical event receipt replay.

Before that observation, unseen Started, Progress, ApprovalRequested and
CompletedProposal are refused without spending their sequence. Failed, Lost and
exact issued cancellation acknowledgement remain available for truthful cleanup.
Committed canonical event replay keeps its existing authenticated historical
precedence. The pump must retain the exact init frame/key on transient failure,
await persistence before Started or further output, and quarantine foreign identity.
An initialize ACK must never be passed to the verified-native confirmation API.

This source boundary does not qualify a real provider, broker transport, account,
workspace, owned-child reaping or server composition. Those remain independently
reviewed adapter duties. No alternate credentials or provider fallback are added.
