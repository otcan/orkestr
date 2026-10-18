# Runtime migration review proposal

Status: source proposal against frozen port version 2, core commit
`93460326d0e73e021e6dbc54a262a8c9a6eb8f0a`. No runtime SQLite implementation or
migration exists. This document supersedes historical runtime store sketches;
core owns all shared contracts, application ports, schema and durable authority.

Runtime imports the ten native future-returning `RuntimeStore` methods and
contracts-owned UUID IDs, admission, observation and lifecycle records. Both
application port names denote the same trait. No async-trait dependency remains;
crate-local application/contracts path dependencies await coordinator lock work.
No Tokio or executor dependency is needed by the ready-future test spies.

The adapter proposal retains these invariants:

- Core-returned role is checked; caller expectations cannot assign authority.
  `start` returns `DispatchUnconfirmed` even for a valid admission until core
  specifies how a fresh dispatch differs from an idempotent replay. A replay
  never blindly starts an active or completed run. Store admission must atomically
  acknowledge the inbox handoff; runtime never creates a second claim/store.
- Observation keys bind run, attempt, generation and local sequence. Transient
  Unavailable retains identical key/body. Stale, expired or unauthorized refusals
  latch reconciliation without polling again. This cursor is volatile, not a
  durable recovery mechanism. CompletedProposal is evidence, never task success.
- Durable cancellation precedes interruption. Original execution identity and
  cancellation-acknowledgement purpose remain distinct. The fake rejects stop
  tokens on start, preserves queued terminal evidence on a stop race and only
  binds the cancellation token after the explicit interrupt command. Unknown
  in-flight outcomes remain unknown when interruption fails.
- Recovery, native binding confirmation, admission/ack transactions, lease
  expiry and event dedup are core store responsibilities. No provider wait,
  live inference, effect retry or automatic provider restart is introduced.
  Unimplemented test-spy methods return Unavailable, not fabricated success.

Required durable acceptance remains separate: concurrent role/native uniqueness,
ordered competing claims and expiry/reclaim, admission rollback and idempotent
handoff, changed-body dedup conflict, owner/scope isolation, atomic cancellation
fence/control outbox, stale observation/effect rejection, and restart recovery
preserving unknown dispatches for explicit reconciliation. Core must extend the
shared journal/event DTO compatibly; runtime owns no alternate journal.

Verification status: 21 migrated Rust tests are defined, not compiled at this
proposal head. Prior combined-base 16-test results do not transfer. Cargo and
download work remain held until coordinator readmission. No formal approval,
build pass, dispatch implementation or durable acceptance is claimed.

## Canonical observation clarification

This source revision restores only contracts/application paths from core
93460326d0e73e021e6dbc54a262a8c9a6eb8f0a, superseding the intervening explicit
v0 handoff. Runtime uses record_observation and shared ProviderObservation,
ObservationKind and ObservationReceipt; no second port is introduced.
Unavailable/Busy retain the identical event and key, including lost commit ACKs.
StaleLease/Expired deliberately discard the queued delivery and latch refusal;
this is not acknowledgement, restart or readmission. Conflict retains evidence
and latches a visible blocker with no acknowledgement. Core must atomically
validate lease/fence/expiry, derive payload digest, require matching event key,
and return the original receipt on identical retry after durable commit.
SQLite observation support remains Unavailable. The spy models receipt dedup,
not durability. 21 tests are authored, unexecuted at this revision. No cargo,
formatting, root/lock mutation or CI pass is claimed. Source was published in
draft PR #76 at 2c9fd0fa72ea849d8beb39e73f2e0c485fef029d and independently
reviewed with no blocking source finding for the bounded migration. This is
source review only; root/lock and integration gates remain coordinator-owned.
