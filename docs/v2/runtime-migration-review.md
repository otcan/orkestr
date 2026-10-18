# Runtime v4 source migration review

Canonical origin: core 7d3c8695e4db2bca3f39c3e4a922086239e10852, frozen port
version 4, PR #82. Migration parent: afff3c3df7b7563d13944ad7e6d4e10f69635c27.
Contracts/application crate paths are imported exactly from that origin, including
crate-local manifests. This supersedes the owner-selected d4cf6934 async-trait
migration; the canonical trait again uses native Future + Send. Runtime removes
its test-only async-trait dependency and spy annotation. No competing port/store
or new dependency is introduced. Root manifest/lock, toolchain, schema/store,
domain/demo and CI remain untouched by this migration.

Runtime imports core UUID IDs and web-safe observation types from contracts;
native bindings/admissions/claims/cancel/recovery authority comes only from
application::runtime, absent from the web-safe contracts crate. There is only
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

Core's frozen v4 rule checks authority before duplicate acknowledgement too.
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

26 runtime tests authored: 13 offline, 7 ordering, 6 retry. Added raw-progress
unavailable and committed-lost-ACK-then-revoked-authority cases; stale delivery
coverage includes Fenced. All are unexecuted/uncompiled at this migration head.
Spies are ready-future protocol evidence only, never durability or restart credit.
Prior canonical/migration source reviews and historical exact aec7475b 16/16
results do not transfer to this revision. No heavy compilation, tests or CI pass
is claimed. Coordinator alone resolves root/lock and final source union after
independent review. Exact-head build/tests remain pending that handoff.

## Deep-only handoff boundary

Before calling admit_run, runtime rejects non-Deep expectations and any binding
that differs from claim.consumer_session_id. Returned scope/session/role/purpose
is still validated. Worker allocation remains a separate lifecycle; worker run
admission has no reviewed port and is blocked before consuming a deep claim.
Tests cover both cases plus a faulty store returning Worker for expected Deep.
The stale-delivery ordering test now expects the canonical discard behavior
rather than its obsolete retained-queue assertion; no test execution is claimed.
Core alone implements atomic claim consumption plus Starting or rollback.
Renewal continues to pass the whole admission with its owner/session locator.
Queued CompletedProposal/Failed/Lost evidence and cancel identity checks remain
unchanged. Source import changes no durable adapter or acceptance implementation.

## Metadata mapping agreement 0f825edb

Core docs-only agreement 0f825edb9dc2e7101987b42db507ccf8473774fe was inspected;
frozen shared types stay exactly 7d3c8695. Keys are now
run:<run-uuid>:<decimal-sequence>, allocated once per pending input. The DTO has
no numeric sequence field: no store-enforced run-local monotonicity is claimed.
A recovered process cannot safely create a fresh cursor and assume authority.

StaleLease/Fenced/Expired remove the delivery item but retain its exact admission,
kind/key/body in one bounded volatile rejected-evidence slot, exposed for explicit
reconciliation. It is not an ACK or durable rejected-evidence API; no terminal
kind is relabeled or automatically restarted. ApprovalRequested stays informational,
Completed maps only to CompletedProposal. Raw progress remains PayloadUnavailable;
frame and 8 KiB candidate progress/result bounds apply in Codex/Claude parsers.
The fake handles only metadata references, never durable payload creation.
One new parser-bound test plus strengthened refusal assertions are authored;
all 26 tests remain unexecuted. No heavy build, schema/store or dependency change.
