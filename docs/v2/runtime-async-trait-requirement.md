# Runtime async-trait requirement

Status: owner-directed source requirement superseding the native Future+Send
runtime agreement at 93460326. Source migration and independent review must
precede coordinator-owned root/lock integration. This patch does not update a lock.

`v2/crates/application/src/runtime.rs` defines RuntimeStore with Send + Sync and
`#[async_trait]` (default Send futures; never `?Send`). Method arguments remain unchanged. Nine result types are unchanged; admit_run
now returns application-owned RunAdmissionResult { admission, is_new }. The SessionStore alias denotes the same trait.
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

The fresh result is per invocation: only insertion returns is_new=true, every
identical replay returns false. Role must be validated against the durable binding.
This is a port requirement, not store enforcement; runtime dispatch remains blocked
until independently tested durable admission exists. No blind restart after a
commit/dispatch crash gap is authorized.
