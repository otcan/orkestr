# Schema31 installation acceptance

The installation adapter admits exact known-checksum populated schema14 and
schema17 prefixes to Core source `41309628e21e6580df458346607220f6413ccc63`,
contiguous schema1–31. Core's contract and per-file SHA256/SQLx SHA384 fingerprints
are published in `schema/schema31-upgrade-contract.md` and
`schema/schema31-fingerprints.json` at Core checkpoint `4a04035a5`.
The compact sorted migration SHA256 inventory digest is
`4b7535910df4a0351e6984d26bc0b892a46fa318432e9d6c73ca114683cd180c`.
Schema32 and later remain inspection-only and cannot execute through this adapter.

`v2/packaging/candidate/accept_upgrade.py --new-schema 31 --migrations-dir PATH`
requires the exact inventory, retained original package/binary pins, unchanged
historical migration checksums and a matching embedded-identity successor package.
Existing stopped-state locks, whole DB/WAL/SHM copies, source inventory preservation,
copy-first successor migration and FK/history checks precede writable migration of
the original disposable fixture. Backward refusal runs only on a disposable copy;
rollback uses the untouched stopped predecessor home and original executable.
Never reopen a migrated database with its predecessor executable.

The schema31 authority audit compares stopped preflight-copy state with upgraded
copy and working state. Old queued/claimed tasks must become held with claims
cleared; historical held/delegated task receipts and delegation authority remain
unchanged. Added execution authority is refused. This audit does not infer browser
logout invalidation, activate imported authentication, or qualify providers.

Disposable SQLite tests apply actual Core SQL to populated schema14/17 history
and separately schema30 pending/held/delegated tasks. They check retained message
history, task payloads and delegation receipts, issuer-lineage refusal, FK and
integrity checks, and reopen without pending-task reactivation. Run with an exact
Core SQL directory, outside any live state:

```sh
ORKESTR_V2_MIGRATIONS_DIR=/path/to/exact-core-migrations \
  python3 -B -m unittest discover -s v2/local-install/tests -p test_schema31_contract.py -v
```

Actual retained schema14 and schema17 package-to-schema31 copy-first upgrade,
reopen, backward refusal, stopped backup/dormant rollback and untouched predecessor
rollback passed against development pair `25b3bbb463bd1e71f7c9f2f8eb72e43348b64b4d`.
Exact artifact identities, executed checks and cleanup are recorded in
[schema31-install-checkpoint.json](schema31-install-checkpoint.json).
The original binaries create populated message history; those historical schemas
have no worker tasks. Pending-task hold behavior is covered separately by the
actual populated schema30-to31 SQL test, not inferred from empty task tables.

The producer's bounded development receipt was normalized to existing packaging
receipt fields after byte-only ELF/WASM identity, inventory and source SQL checks;
this creates no new build attestation. Historical package labels remain integrity
metadata only. The successor package retains embedded `2.0.0-dev` identity.
Docker runtime acceptance, browser/provider acceptance, gated daily-use launcher
start and production soak remain unexecuted for this pair. No RC qualification,
schema32/33 assumption or historical acceptance transfers.
