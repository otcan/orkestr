# Runtime v3 source migration review

Canonical origin: core 1ecfd1e84af05af580186f171f954f28ef3a9e27, frozen port
version 3, PR #82. Migration parent: 330375d8a3ed32281dd6fed571a16f49c5a47d9b.
Contracts/application crate paths are imported exactly from that origin, including
crate-local manifests. This supersedes the owner-selected d4cf6934 async-trait
migration; the canonical trait again uses native Future + Send. Runtime removes
its test-only async-trait dependency and spy annotation. No competing port/store
or new dependency is introduced. Root manifest/lock, toolchain, schema/store,
domain/demo and CI remain untouched by this migration.

Runtime imports core UUID IDs, admissions and observation types. There is only
RuntimeStore::record_observation(admission, event_key, observation); runtime owns
Provider/Blocker, fake source, protocol parsing and supervision. Core owns all
schema, payload storage, durable operations and acceptance tests.

## Authority and dispatch

High-level start validates store-returned owner/scope/session/role and Execution
purpose, then returns DispatchUnconfirmed for every admission. An identical
admission replay is not fresh dispatch permission. Caller role cannot manufacture
provider authority. Cancellation-only tokens cannot start a provider; cancellation
receipt identity/generations are validated before sending interrupt control.
Terminal evidence remains preserved if interruption races a queued terminal.
Native namespace/supervisor authority and fresh dispatch disposition remain
unresolved core contracts. Relevant durable methods remain Unavailable.

Each observation includes the original admission's u64 lease generation and
explicit dispatch fence. No conversion/truncation to a database integer occurs
in runtime. Key/body/admission remain unchanged across Unavailable/Busy, including
lost commit ACKs. StaleLease/Fenced/Expired deliberately discard delivery and
latch refusal without repoll, readmission or restart. Conflict, unauthorized or
invalid input remain visible latched blockers, not acknowledgements. Refusal
never changes Stopped into successful cancellation. Only core's committed receipt
can acknowledge; CompletedProposal remains AwaitingAcceptance evidence.

Core's frozen v3 rule checks authority before duplicate acknowledgement too.
Thus a committed event whose ACK was lost may subsequently receive explicit
Fenced/Expired refusal. That neither undoes the earlier commit nor acknowledges
the retry. The authored spy regression models this ordering; it establishes no
database durability. Runtime never provides a trusted digest: core must compute
it, check event-key equality and enforce scope/lease/fence/expiry atomically.

## Progress payload boundary

Raw Progress text is absent from shared observations. ProgressRef contains only
a PayloadId. Codex raw delta parsing returns PayloadUnavailable after checking
frame and provider identity, because no removable payload store exists. Runtime
never invents a durable payload ID or relabels provider output as owner input.
The explicit fake may queue synthetic ProgressRef IDs for bounded queue tests;
those references assert no existing stored payload. Core must validate existence,
ownership and policy before any durable acknowledgement. No pretend payload
endpoint, payload store or production fallback is introduced.

## Review and validation

23 runtime tests authored: 12 offline, 5 ordering, 6 retry. Added raw-progress
unavailable and committed-lost-ACK-then-revoked-authority cases; stale delivery
coverage includes Fenced. All are unexecuted/uncompiled at this migration head.
Spies are ready-future protocol evidence only, never durability or restart credit.
Prior canonical/migration source reviews and historical exact aec7475b 16/16
results do not transfer to this revision. No heavy compilation, tests or CI pass
is claimed. Coordinator alone resolves root/lock and final source union after
independent review. Exact-head build/tests remain pending that handoff.
