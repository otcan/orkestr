# Published schema34 installation readiness

Exact source `63366a48788b41998ec3fdcabf7de3dc20ca2d97` contains contiguous
schema1–34. `v2/packaging/candidate/schema34-fingerprints.json` records every SQL
SHA256 and SQLx SHA384. Its inventory digest is
`2c9fa817bc66fdf87d8c15253e7394b08a69ebbacaea3ae0733ae631709e24b4`.
The prior33 migration bytes match the pinned schema33 inventory unchanged.
Only the published `0034_production_steering.sql` is added. No35+ is inferred.

Candidate inspection with `accept_upgrade.py --new-schema 34 --migrations-dir PATH`
requires that exact inventory and checksums. Execution remains typed
`pending_core_edge_admission` and refuses before invoking the migration harness.
Core's specific supported historical-prefix decision has been requested. This is
an edge-contract dependency, not a request for user permission. Matching immutable
server/UI artifact acceptance is also pending; separate Worker32/timer33 process
builds cannot qualify schema34 or a combined source identity.

The existing stopped locks, copy-first DB/WAL/SHM and FK/checksum preflight,
backward-refusal-on-copy and untouched predecessor rollback remain the execution
path once a supported edge is published. Authority audits now include both
steering rows and native-turn mappings, refusing any added/changed ledger rows in
these nonprovider historical fixtures. No existing timer or task is activated.

Executed exact-SQL disposable SQLite checks cover populated14/17 history through34,
populated31 held/delegated tasks and paused imported timer preservation through34,
and populated33-to34 history/reopen with empty steering, result and durable timer
authority tables. SHA256/SHA384, FK and integrity checks pass. These are SQL runner
checks, not a Store build or actual schema34 package migration.

```sh
ORKESTR_V2_MIGRATIONS_DIR=/path/to/exact-core34-migrations \
  python3 -B -m unittest discover -s v2/local-install/tests -p test_schema34_contract.py -v
```

No build, provider, Docker, browser, RC, production deployment or soak acceptance
is attributed to this source-preparation checkpoint.
