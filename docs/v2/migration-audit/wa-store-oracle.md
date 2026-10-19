# Independent preserved-input Store oracle

Source pin: Core `54ad06e408c746b32b67622bce86643d800b1793`, schema39.
Oracle: `v2/fixtures/migration-audit/wa-preservation/store_oracle.rs`.
Install only that file as a store-sqlite integration test in a disposable archive
of the pin; preserve manifests, lockfile and authoritative SQL unchanged.

The synthetic oracle calls ordinary authenticated preservation, permission,
trusted ingress and reservation ports. Seven inputs span all historical effect
classes, unknown source generation, independent input/hold revisions and full
u64 counts. It compares persisted typed provenance and hold/route columns,
refuses changed provenance and imported-identity adoption, and requires every
import reservation to fail even with explicit target permission. A fresh input
must receive one reservation followed by receipt-only replay. Reopen retains
import receipts; current credential revocation refuses even exact import replay.
No delivery capability is consumed and no transport callback runs.

This is direct canonical DTO construction, not a legacy tuple converter. Unknown
source enums omit `value`; absent observed_at remains distinct from created_at.
The seven records are synthetic, not a public copy of a private overlay.
The prior Python check's 128-record batch cap never permits discarding evidence.

Execution is UNEXECUTED pending bounded build admission. Formatting and diff
checks alone do not establish compilation, Store acceptance or transport safety.
No process crash, browser, live import, automatic sender or external effect claim.
