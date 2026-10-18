# Workspace integration candidate

This candidate combines the existing integration base `2c9e1001`, core intake
`f8e1af18`, and offline runtime `5481e6b0`. It is a review branch, not a claim
that runtime adapters are connected to the durable intake server.

## Preserved boundaries

The integration base's internal `JournalRecord`, reducer, serialization tests,
demo, parity inventory and versioned metadata documentation are retained.
Core's pure ingress validators live in a separate domain module, re-exported for
its existing callers. The domain permits serde for that existing offline record;
it still cannot depend on SQLx, Axum, Dioxus or runtime adapters.

Core's authenticated intake schema remains authoritative. This candidate adds no
parallel SQLite adapter or schema. The archived durable journal and Dioxus spike
remain independently preserved artifacts for compatible test/component adoption.

Workspace membership and one root lockfile include both intake and offline
runtime crates. The dependency pins already agree on serde_json 1.0.145. Lockfile
resolution uses the pinned shared build wrapper in an isolated development target.
No provider call is part of workspace verification.

## Unresolved integration gates

Core's proposed application runtime port is in
`crates/application/src/runtime.rs`. Runtime's earlier adapter proposal is retained
as [runtime-adapter-port-proposal.md](runtime-adapter-port-proposal.md), alongside
Core's [runtime-store-proposal.md](runtime-store-proposal.md), to avoid silently
discarding either proposal during the merge. They are not two approved contracts.
The runtime crate still uses provisional ports. Its migration to core's typed
ports and the durable session store require review before runtime integration
acceptance. Offline supervisor tests do not establish restart durability.

Browser-session/Bearer-auth reconciliation, cancellation/effect authority, real
server/UI wiring, native iOS and real-provider execution remain pending. Exact-head
tests and independent reviews are required before merging this candidate into
`v2/rust-rewrite`. No main merge, deployment or production state change is involved.
