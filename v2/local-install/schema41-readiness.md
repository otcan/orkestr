# Schema41 copy-first package readiness

This extends the historical schema39 installation checkpoint. It does not qualify
schema41 packages, activation, credentials, workspace grants, Memory imports or
production restoration. No matching sealed schema41 native/web pair was supplied
for this checkpoint. Existing historical artifacts and backups remain unchanged.

The exact source is `d1bc4c327aed27675579d831104cb36c0996e1fd`.
Its `docs/v2/memory-service-api.md` publishes populated exact-prefix support for
14/17/31/33/36/37/38/39/40 to41. Installation's
`tests/schema41-fingerprints.json` pins every migration's SHA256 and SQLx SHA384;
the first39 entries are unchanged from Installation's retained schema39 inventory.
Schema40 adds workspace authority storage; schema41 adds consent-only Memory
storage, with no inferred inference, routing, timer or effect authority.

The package preflight requires the complete exact source inventory and SQLx
checksums. Unsupported prefixes, future targets, altered historical SQL and
missing sources refuse before exercise. The existing cross-revision runner uses
original pinned predecessor packages, stopped exclusive state, retained backup,
copy-first candidate migration, ordinary reopen, backward refusal on a disposable
copy only, and rollback by restoring untouched predecessor bytes. It never runs
the old executable on the migrated working database.

## Smallest disposable fixtures

| Fixture | Source | Preservation assertion |
| --- | --- | --- |
| Owner/conversation/message/event history | Each of nine supported prefixes | Every prior table row and column remains equal; original and rollback bytes unchanged |
| Retired workspace project, session binding and delivery-unknown launch | Schema40 | Generation2, inactive project, blocked native binding and attempted unknown launch remain unchanged; no path or FD grant is constructed |
| Empty new authority stores | Prefixes below40 / all prefixes below41 | No workspace backfill, no Memory setting/record/decision backfill |
| Disabled synthetic Memory with correction receipt | Schema41 stopped fixture | Exact record/revision/unknown JSON bytes and decision receipt survive stopped backup/restore; settings remain disabled and workspace remains inactive |
| Denied creation during schema41 migration | Schema40 copy | Transaction rollback removes partially created schema41 tables; prior rows and original bytes remain unchanged |

`tests/test_schema41_contract.py` uses exact SQL with Python SQLite, not Store
issuance or SQLx package execution. `tests/test_schema41_upgrade.py` under the
candidate packaging tests prepares all nine edges against exact sources with
synthetic package verification boundaries; it launches no executable.
`tests/upgrade_authority.py` now compares workspace and Memory ledgers during
actual package exercises, in addition to retained task/timer/result authority.

## Remaining gates and owners

- Coordinator/build owner: matching immutable native/web schema41 pair with
  embedded same-source/version identity, complete migration receipt and hashes.
  A mutable binary or historical schema39 pair cannot satisfy this gate.
- Installation: execute each available original-package edge only after that
  handoff, preserving backup and recording exact package/schema/source identities,
  copy-first reopen, refusal and rollback outcomes. Source support for nine edges
  is not evidence that nine original executable artifacts are available.
- Core: issuer-valid populated workspace/Memory fixtures for API-level authority
  qualification, if required beyond these inert SQL fixtures. Raw fixture rows
  do not create opaque grants, current FDs, consent or restored account authority.
- Runtime/Isolation: descriptor-based workspace reopen/revocation behavior and
  session-preserving execution; these remain separate from installation bytes.

Run the narrow source rehearsal with an exported exact41 migration directory:

```sh
ORKESTR_V2_MIGRATIONS_DIR=/path/to/exact41/sql \
python3 -B -m unittest discover -s v2/local-install/tests -p 'test_schema41_contract.py' -v
ORKESTR_V2_MIGRATIONS_DIR=/path/to/exact41/sql \
python3 -B -m unittest discover -s v2/packaging/candidate/tests -p 'test_schema41_upgrade.py' -v
```

Absent that explicit source directory, these source-dependent tests skip and
remain unexecuted. Actual matching-package and production restore checks remain
unexecuted regardless of source-test results.
