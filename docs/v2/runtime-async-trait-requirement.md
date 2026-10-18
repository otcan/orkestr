# Runtime async-trait requirement

Status: owner-directed source requirement superseding the native Future+Send
runtime agreement at 93460326. Source migration and independent review must
precede coordinator-owned root/lock integration. This patch does not update a lock.

`v2/crates/application/src/runtime.rs` defines RuntimeStore with Send + Sync and
`#[async_trait]` (default Send futures; never `?Send`). All ten method argument and
result types remain unchanged. The SessionStore alias denotes the same trait.
Implementations must use the same attribute; application reexports it so runtime
adapters and test spies can use `#[orkestr_v2_application::runtime::async_trait]`
without a second direct dependency. The only new dependency declaration is
`async-trait = "=0.1.89"` in application/Cargo.toml. Contracts/DTOs are unchanged.
IntakeStore remains unchanged; this requirement is scoped to RuntimeStore.

This supersedes the native runtime signatures only, not ownership, transaction,
lease/fence, idempotency, cancellation or acceptance requirements. No runtime
SQLite implementation, admission dispatch authorization or durability acceptance
is supplied. Implementations not migrated to the attribute may fail compilation.

No Cargo or downloads were run. Locked checks remain pending coordinator lock
integration after migration/review; no earlier-head pass certifies this patch.
