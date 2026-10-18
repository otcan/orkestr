# Opt-in dormant history transaction probes

Feature `fixture-test-controls` adds ordinary Store method
`production_arm_history_checkpoint(credential, owner, stage, fresh_marker)`.
It requires exact current credential/owner and an unbound Store, accepts only the
four history stages below, and does not create a conversation or provider grant.
Arming does not replace import/rollback authentication inside their transactions.
No normal server bootstrap arms these controls.

| Typed stage | Exact marker bytes / internal call name |
| --- | --- |
| HistoryImportBeforeCommit | history-import-before-commit |
| HistoryImportAfterCommit | history-import-after-commit |
| HistoryRollbackBeforeCommit | history-rollback-before-commit |
| HistoryRollbackAfterCommit | history-rollback-after-commit |

Migration owns the feature-gated calls within `history_import`, using the
crate-visible `production_checkpoint(name)` and mapping its error to
`HistoryError::Unavailable`. Before markers belong after every write and verified
receipt construction, immediately before COMMIT. After markers belong immediately
after successful COMMIT and before receipt delivery. There is no second writer.

The marker is create-new, synced and closed before a bounded 30-second pause.
An owned parent waits for exact bytes, SIGKILLs/reaps only its child, then opens a
new process for read-only comparison and authenticated retry. A missing parent
times out with Unavailable: before COMMIT rolls back, after COMMIT preserves
original durable evidence. These new stages do not resume on marker removal.
History import/rollback hook execution and full process acceptance are separate
from Core's arming/authentication regression.
