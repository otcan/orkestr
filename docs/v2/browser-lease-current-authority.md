# Browser lease current-authority source gate

The workflow census distinguishes unreleased lease history from current operation
authority. This investigation exercises existing JavaScript source; it neither
implements nor qualifies a V2 managed-browser connector.

## Existing seams

- `packages/browsers/src/desktop-lease-store.js`: owner/desktop scoped persisted
  snapshots, lease identity, fencing token and monotonic acquisition version.
- `packages/browsers/src/desktop-leases.js`,
  `assertDesktopLeaseForOperation`: enforce-mode checks current owner/thread,
  expiry, heartbeat age/future skew, exclusive mode and supplied identity/fence.
- `packages/browsers/src/desktop-capability-broker.js`,
  `consumeDesktopCapability`: revalidates current policy and consumes a one-use
  capability, then performs another lease read before returning connection data.
  Its expected-lease-ID path deliberately permits omission of the raw fencing
  token; callers must retain the complete issuer-bound identity/version.

`v2/apps/server/src/browser.rs` is web authentication, not a managed desktop lease
adapter. Census rows, copied lease records and imported browser references must
remain inert. No native browser profile/cookie or existing session adoption is
established here.

## Executed synthetic gate

Run from the repository root with installed repository dependencies:

```
node --test v2/acceptance/browser/lease-current-authority.mjs
```

Six tests call the actual guard and store without source extraction or mocked
policy checks. Every fixture creates and removes its own temporary home. They
write synthetic snapshots directly; no acquisition, heartbeat, release, managed
API or browser/process launch occurs. The cases cover a current positive lease,
released/expired/stale records, replacement ID/version/token, foreign owner/thread,
nonexclusive mode, malformed dates/future heartbeat and revocation after a
successful read. Each check reopens the persisted store. The retained successful
snapshot remains unchanged after release; a subsequent guard read refuses it.

Execution in the implementation checkout: six passed, zero failed or skipped.
A direct run initially failed at module loading because a transitive legacy
import required an absent `age-encryption` package. The passing run used a
temporary external Node resolver to resolve missing bare dependencies from an
existing installed checkout; all repository source imports remained those of
this checkout. No dependency download, manifest edit or dependency stub was used.
The ordinary dependency-complete command above was not rerun in this checkout.

## Unresolved current-action contract

The consume-time and post-consume lease reads are separate from opening a CDP
channel or performing a browser action. They narrow a race; they do not serialize
revocation with the actual action. These tests prove refusal on the next read,
not cancellation of an already open channel or a concurrent browser operation.
The guard is conditional on enforce mode and permits authorized break-glass;
this test does not qualify those separate policy decisions.

A future V2 adapter needs a private issued operation bound to owner, desktop,
thread/run, lease ID, fence version, resource-policy revision and short deadline.
The manager must enforce the same current fence at the actual bounded action
boundary, retire channels on revocation/replacement, reject stale replies and
classify already-issued side effects as uncertain. Owner authorization and
resource-policy revocation remain separate from lease release. A caller's raw
lease JSON or previously successful guard return must never mint this authority.

No existing-source patch is proposed without the manager-side fencing contract.
Required next dependency is a designated manager adapter/issuer owner and an
exact action/revocation serialization API. Live lease acquisition, browser launch,
revocation races against an actual manager and V2 end-to-end acceptance are
unexecuted. No current live-browser authority is claimed.
