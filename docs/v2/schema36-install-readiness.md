# Pinned schema35/36 installation readiness

Immutable inspected Core source is `006cca798e967fbd8deecd128933e46a2e0e94a8`.
`v2/packaging/candidate/schema36-fingerprints.json` records contiguous1–36 SQL
SHA256/SQLx SHA384 fingerprints. Prior1–34 match the retained schema34 inventory
without rewriting SQL. Prefix35 inventory digest is
`66c9b7bac0991274ff462f2cb04b43ca0edc71eade81b92d32cf0fbdcd98711c`;
full36 digest is
`3037e742dd4578ab3a1e886cc69eed0ba7a7f2340250434301dc3b9582b91d7b`.

Schema35 introduces an empty Worker running-budget ledger. Schema36 preserves
existing ledger rows while changing the deadline constraint and adds nullable
owner execution budgets. Historical tasks remain NULL; migration alone gives no
host/owner opt-in, renewal, native grant or activation authority. Imported timers,
held work, delegated receipts and existing authority rows remain unchanged in
these nonprovider fixtures. The installation authority audit refuses new/changed
running-budget rows or owner execution-budget values.

Exact SQL runner checks executed on disposable SQLite cover populated14/17/31/33
history through36; populated held/delegated tasks, payloads and paused timers;
empty new budgets and NULL historical task budgets; valid expired35 ledger
preservation through36; lower/upper budget/deadline constraint refusals; FK,
integrity and reopen checks. An injected INSERT denial during a transactional
copy migration proves rollback of partial DDL/copy work and byte-identical stopped
original preservation. This is an explicit test fault, not a product bypass or
Store/package migration qualification. A copied SQLite fixture is closed before
copying; product backup remains the existing stopped lock/DB-WAL-SHM protocol.

```sh
ORKESTR_V2_MIGRATIONS_DIR=/path/to/exact-core36-migrations \
  python3 -B -m unittest discover -s v2/local-install/tests -p test_schema36_contract.py -v
```

Core's published `docs/v2/schema36-upgrade-and-claude-stop.md` admits exact
known-checksum populated14/17/31/33→36 edges. All36 published SHA256/SQLx SHA384
fingerprints were compared with the retained inventory and actual committed SQL;
no prior SQL changed. Candidate preparation now admits precisely these36 edges,
requiring exact source inventory, SQLx checksums, retained original packages and
version/source/embedded-identity agreement. Schema35 remains inspection-only;
unknown edges and backwards execution refuse.

The actual runner requires exact SQLx checksums and audits task holds, delegated
receipts, timer/result/steering authority and host/owner budgets on the independent
preflight copy, writable working copy and ordinary reopen. It reuses stopped
DB/WAL/SHM locking/copies, retained backups, isolated old-binary refusal and
rollback with the untouched predecessor. Core's source/Store results do not
substitute for original-package execution or populated native/timer/task coverage.

Actual14/17/31/33-to36 package migration/refusal/rollback is **unexecuted** pending
coordinator's immutable combined36 same-source server/UI pair.
Original14/17 packages,31 development pair and actual33 acceptance receipts/raw
logs/stopped backups remain retained. The old f322 binary is never substituted
for36. Separate Worker or steering builds do not qualify combined36. No37+,
downgrade compatibility, credential activation, Docker/provider/browser, RC,
production deployment or soak acceptance is inferred.
