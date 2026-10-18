# Pinned schema33 installation gate

This is source preparation, not executed package acceptance. Core explicitly
supports exact known-checksum, structurally valid populated prefixes14,17,31 to
schema33 at `941c76ec8`. Full source identity, all 33 SQL SHA256 and SQLx SHA384
fingerprints, and compact inventory digest are recorded in
`v2/packaging/candidate/schema33-fingerprints.json`.
The inventory digest is
`24430c423063e077633458198512834c603758c005136f15ba6d21557e0a3faf`.
The first31 SQL files match the previously reviewed Core413 inventory unchanged.
Schema32 is `0032_worker_tool_results.sql`, SHA256
`ff4d7c0c26d224b2382a8aedac87df0b4bbfefbc37c22b84356b82f784ce3df8`;
schema33 is `0033_durable_timer_authorities.sql`, SHA256
`b7f5857277c7a9af78d53da67e15c75bb249b6723fd7f15d407ec842ccb6d44b`.
No schema34 source or edge is admitted by this checkpoint.

Use the existing candidate `accept_upgrade.py` with explicit `--new-schema 33`,
exact `--migrations-dir`, original/new candidate roots, full source identities and
binary pins. Execution additionally requires explicit fresh private parent and
assigned loopback port. Unsupported edges remain inspection-only. Exact33
inventory, SQLx history and embedded successor identity are mandatory. Existing
stopped-state locks, DB/WAL/SHM copies and original-file inventory checks apply.
Copy-upgrade/FK/history preflight must pass before writable original migration.
Successor reopen and untouched predecessor rollback retain their original
artifacts. Old binaries run on migrated databases only in a separate intentional
refusal copy. Same-package dormant restore is tested without activation;
cross-package auth import remains refused.

The authority audit now rejects changes to existing timer schedules, result rows
or durable timer authority rows. Newly introduced tables must remain empty for
historical fixtures. Existing pending tasks become held through migration31;
held/delegated receipts and payloads survive. A paused imported timer, including
its source-enabled provenance, stays paused; no unattended authority is inferred.
This is a nonprovider acceptance fixture, not a general live timer upgrade test.

Executed checks use Python SQLite with exact committed Core SQL, FK enforcement,
SHA256/SHA384 comparisons and integrity/reopen checks. Populated14/17 history
survives through33. A populated31 fixture retains held/delegated tasks, payloads
and a paused imported timer through32/33; result and durable authority ledgers
remain empty. This uses the existing migration SQL runner, not a new Store build.

```sh
ORKESTR_V2_MIGRATIONS_DIR=/path/to/exact-core33-migrations \
  python3 -B -m unittest discover -s v2/local-install/tests -p test_schema33_contract.py -v
```

Actual matching schema33 binary/package upgrade, rollback and restore acceptance
remain **unexecuted** pending coordinator's immutable same-source server/UI pair.
Retained original14/17 packages and development31 pair are available as old inputs;
no duplicate build is needed. Historical31 acceptance is separate. No Docker,
provider/browser, RC, deployment, activation or production-soak claim is made.
