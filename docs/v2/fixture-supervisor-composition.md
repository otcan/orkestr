# Private fixture supervisor composition

The source gate is `v2/crates/orkestr-runtime/tests/fixture_composition/`:
`supervisor.rs` owns the private support type and `cases.rs` exercises actual
SQLite transactions plus explicit FakeProvider I/O. Neither file is exported by
the runtime library, server, browser or normal supervisor. There is no new shared
port, bootstrap constructor, dependency, root manifest or lock change.

Runtime owns adoption after source review. Its existing store-sqlite/tokio test
edges and feature are sufficient. A test-only driver registers these cases:

```rust,ignore
#[path = "fixture_composition/cases.rs"]
mod composition;
```

The Core branch retains its historical runtime manifest without those test edges;
the nested source is therefore deliberately not registered there. Validation uses
Runtime's published `a952df834cce3d4a75b84a9eaa57e62403b6147e` manifest and
lock unchanged in an isolated checkout, with the exact new source and the driver
above. Application/contracts/store sources at that base match Core 72784259.
No resolver or lock generation is used. These results do not claim that Core's
normal CI discovers the new tests before Runtime adoption.

## Boundary

`FixtureSupervisor::new` consumes an already authorized concrete
`FixtureSupervisorStore` and creates only an explicit concrete FakeProvider. It
accepts neither an arbitrary RuntimeStore nor an arbitrary Provider. The type is
private integration-test support; it is not a supported product constructor.

`start(claim, authoritative_binding, request_key)` checks Deep role, scope,
consumer, explicit-fixture provider and readiness. It admits atomically, checks
the returned authoritative binding, requires FreshCandidate, reserves once and
consumes once. Only the per-call DispatchNow result reaches fake.start. The store
has already committed DeliveryUnknown. Replay, uncertain or unavailable results
never start a replacement provider; locators are not retained for retries. Fake
start failure cannot undo consumption. Production supervisor::start stays blocked.

`step` reuses Runtime's PendingObservation and canonical append retry logic.
Synthetic completion is AwaitingAcceptance, never Succeeded. A single volatile
sequence cursor advances only after a durable receipt. Pool reopen is not process
recovery, and reconstructing this cursor is not authorized resume.

`cancel` persists the existing exact Core receipt before interrupting. It refuses
to switch away from an unpersisted execution observation. Repeating a committed
request in the same harness returns the original interrupt outcome without a
second interrupt. Interrupted delivery remains Unknown until acknowledgement.

`acknowledge_stop` polls using the original execution envelope. Only an actual
Stopped event is appended with the exact control-purpose receipt and next provider
sequence. It retains that same event across unavailable persistence without
repolling. Racing CompletedProposal/Failed/Lost is retained as rejected volatile
evidence, never relabelled Stopped or acknowledged. No durable reconciliation
store is implied. Already recorded acknowledgement never repolls.

The fixture owns one Deep turn. Fast/Worker admission, renewal during a turn,
general cancellation of a pending observation, recovery, effect dispatch and
real providers remain outside this boundary. Ordinary Store and all production
starts remain unavailable. This is a role-level synthetic composition, not a
browser/client/native-provider acceptance claim.

## Validation

Pinned v2-cargo, isolated Core target/home, Runtime base above plus exact scoped
source, locked/offline:

- Six default actual-store composition cases.
- Seven with fixture-test-controls, adding consumed lost-reply/reopen/no-I/O.
- Strict selected-test clippy with controls; fmt and diff checks.

Cases cover canonical Started/proposal, canonical request/Stopped, active and
terminal replay without replacement starts, mismatched role without admission,
ordinary Store refusal, preserved racing terminal evidence, and retained polled
stop across persistence outage. The lost-reply case uses Core's opt-in reply-drop
facility, not SIGKILL or lost transport ACK. Independent cancellation process
acceptance is a separate artifact and is not transferred to this composition.
