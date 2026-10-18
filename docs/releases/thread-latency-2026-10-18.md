# Long-thread synchronization latency

History reconciliation previously reloaded and parsed a thread's complete
message history for every imported history item. Long threads amplified that
work and garbage collection, delaying live message handling in the shared
control process.

A reconciliation pass now owns a revision-checked message snapshot. Each item
still takes the message mutation lock. A changed SQLite revision reloads the
snapshot before reconciliation, and successful local writes update both the
snapshot and its revision. Failed operations invalidate it. JSON stores retain
the existing fresh-read behavior. No snapshot survives the reconciliation pass.
Message identity, generation fences and delivery reconciliation are preserved.

This train also integrates PR #46: independent setup probes run concurrently,
and message polling reuses pending-question results while the message-store
revision is unchanged. It contains no state migration or model-setting change.
Other feature branches are outside this local-instance repair train.

Validation includes a long SQLite history requiring only one full read per
pass, repeat hydration without duplicates, concurrent writer visibility,
partial-failure invalidation, JSON fallback and separate data homes. Existing
history, identity, projection, paging and connector suites run alongside build,
smoke, boundary checks and exact-commit CI. The operator retains live profiling,
deployment and post-deployment latency evidence outside the public repository.
