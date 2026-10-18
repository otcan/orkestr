# Intake and offline journal compatibility

The Rust foundation incorporates the metadata contract from base `2c9e1001`
without introducing another persistent journal. `JournalRecord`, `Envelope`,
`Event`, `Engine` and the strict serde wire representation remain available in
`orkestr_v2_domain`. The offline demo remains a workspace member and exercises
that in-memory reducer. Its historical Completed state is not verified acceptance
and its Worker/Topic graph kinds do not create product conversations or authority.

Pure intake validation lives beside the reducer in `validation.rs` and remains
re-exported from the domain crate. Serde is the domain's sole normal dependency;
SQLx, Axum and Dioxus remain outside it. The metadata wire format and
[event-contract-v1.md](event-contract-v1.md) are preserved, with their existing
warning that this internal format is not the public authenticated M1 envelope.

The SQLx intake adapter is the only implemented durable authority. Its message,
event, reasoning inbox and outbox transaction does not serialize JournalRecord
or call Engine. No conversion from unscoped historical string IDs to authenticated
owner/conversation IDs is implicit. A future importer must validate versions,
map identities explicitly and apply scoped commands through the application
boundary; deserializing a metadata record never authorizes a run or effect.

The offline journal document describes a storage contract and required tests;
it is not evidence that this branch implements a second journal adapter. Runtime
migration 0002 only adds bindings and claim leases. Versioned runtime events,
tasks, runs, observations and replay projection still need reviewed additive
migrations in the same authoritative store. Neither TaskCompleted metadata nor
a provider completion proposal can bypass verified acceptance.

CI retains exact candidate checkout, pinned toolchain, locked checks, path coverage
and isolation. An explicitly named offline reducer smoke supplements intake tests;
it does not stand in for durable or authenticated acceptance. Root manifest and
lock integration are serialized by the coordinator. Archived experiments remain
read-only references and supply no additional production store.
