# Execution fence post-action refusal probe

With `fixture-test-controls`, an authorized ordinary supervisor handle may arm
`ProductionCheckpoint::ExecutionFenceAfterActionRollback` using
`production_arm_checkpoint(stage, fresh_owned_marker)`. This is not fixture
bootstrap and does not weaken canonical execution authorization. A reattached
handle does not inherit the probe.

`with_execution_fence` first validates the full current admission under BEGIN
IMMEDIATE, then invokes the original bounded callback exactly once. At the new
boundary it closes/syncs the exact marker, rolls back explicitly, and returns
outer `RuntimeStoreError::Unavailable`, discarding the callback return value.
The probe returns immediately; no provider wait occurs under the write lock.
Invalid authority never reaches the callback or marker. Cancellation fences do
not use this execution-only injection.

Independent containment tests can put the actual nonblocking provider suffix
write in the callback and verify bytes reached their owned child's input before
the outer error. They must quarantine/close that transport and retain unknown
outcome, not retry the suffix or return a grant. Previous durable consume remains
DeliveryUnknown; reserve/consume replay cannot issue another capability.

The Core regression uses actual nonblocking Unix socket bytes, complete execution
ledger equality and independent pool reopen/no reissue. It does not launch a
provider and does not claim to reproduce an OS/disk-generated SQLite COMMIT
failure. This deterministic pre-COMMIT rollback exercises the same outer-error
handling boundary after irreversible callback I/O; actual COMMIT uncertainty and
transport quarantine remain separate containment acceptance evidence.

Offline Python workers require their own consumed delegation and worker fence.
A consumed Deep provider capability cannot substitute for worker authority.
