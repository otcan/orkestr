# Schema 36 frozen-copy reconciliation

Installation's existing SQLite backup already retains all tables, committed WAL
rows and migration metadata. Its same-package restore copies into a fresh target
with an activation-blocking marker, and rollback refuses any changed database.
This slice reuses those ports rather than introducing a second backup/importer.

`v2/migration/recovery_reconciliation.py` adds a private application manifest for
an explicit completed `orkestr-v2-local-recovery-v1` snapshot. It pins source
release/commit, whole-file cut digest, contiguous SQLx migration checksums against
supplied canonical SQL, schema digest, typed/multiplicity-preserving table row
fingerprints and fixed state counts. Row text, IDs, credentials, grants and
individual row hashes are never returned. The result is sensitive private
metadata: callers must retain it outside OSS in a mode-0600 private destination.
It has no discovery, live DB, initialization, apply, activation or network port.
Standalone copied files only: a WAL/SHM/journal sidecar refuses, including on a
path incorrectly presented as a frozen snapshot. `immutable=1` is used only at
this explicitly frozen-copy boundary, never for a changing production DB.

The deterministic fixture reads exact published Core
`006cca798e967fbd8deecd128933e46a2e0e94a8` SQL 1..36 from Git, checks every
migration SHA-384 against the copied SQLx ledger and leaves authoritative SQL
unchanged. Task issuer holds are schema **31**, Worker native result provenance
**32**, durable timers **33**, steering **34**, host budgets **35**, owner budget
**36**. The fixture deliberately has no auth session, readiness or live lease.
It is SQL-valid synthetic retention data, not a claim that fabricated runtime
receipts or task budgets are valid Store admissions.

One executable proof populates queued/Stop-held inputs, accepted and uncertain
run evidence, inactive history/provenance, steering queued/unknown/acknowledged,
held owner-budget task/budget, unknown Worker result and disabled timer instruction
provenance. Existing Installation backup captures committed WAL; a later source
message does not change that frozen cut. Existing dormant apply preserves every
table fingerprint; launcher activation refuses. Untouched rollback returns the
fresh target to empty while preserving its own bootstrap/config. Changed history
refuses rollback and reconciliation, retaining the dormant marker and delta.
Checksum changes and sidecars refuse; the source snapshot is unchanged throughout.

Run the single lightweight proof:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s v2/migration/tests -p test_recovery36.py -v
```

This does not extend portable `HistoryRecoveryBundle` beyond ordered owner-message
history. Steering/Worker/task/timer ledgers remain opaque inactive local recovery
only: copying them never manufactures current issuer, session, provider, timer
enable or dispatch authority. `history_import/recovery_rollback.rs` still rolls
back only its exact two child HISTORY_ONLY ledgers, preserving later V2 delta by
refusal; it must not delete native schema-36 data to force bundle rollback.

Old 14/17/31 copy-first upgrade support remains owned by Core/Installation and is
unchanged. The new inspector can describe earlier contiguous schemas, marking
missing projections `schema_unavailable`; it never calls absent features unused.
Reverse import into V1, old-binary downgrade, actual package executable behavior,
Store-issued semantic receipt verification, multi-authority consistency, active
recovery and live mutation are unexecuted and not claimed.

Executed: the single populated proof passed in **5.301 seconds**; Python syntax
compilation and `git diff --check` passed. Test source was
`48f41f08543ab466f77c167f38f850828ae1daba`, then rebased to
`d3ae8417fbc3dd23f4a3566d4fd37787cec9393b` to keep PR111's timer mount out of this
four-file slice. Git verified byte-identical migration tools, Installation helper
and package builder across that scope-only rebase. No Cargo build, download,
server, provider, outbound worker or live state operation was run.

Private synthetic evidence retains the completed SQLite cut, Installation
manifest, reconciliation manifest, all 36 canonical SQL files and their hashes.
No real account/session/credential rows were read. An earlier execution of the
first checkpoint passed in 4.125 seconds before optional evidence retention was
added; it is not counted as an additional scenario.
