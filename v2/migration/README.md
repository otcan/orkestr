# Inert migration tools

Python standard library only; no installation, Cargo or network required.
See `docs/v2/migration-audit/implementation.md` for the proposed adapter edge,
source mappings, executed evidence and exact Core dependencies.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s v2/migration/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 v2/migration/migrate.py validate v2/fixtures/migration-audit/snapshot-v1
```

Commands require explicit paths:

- `validate SNAPSHOT_DIRECTORY`: manifest, record and artifact validation.
- `plan SNAPSHOT_DIRECTORY PRIVATE_LEDGER_FILE`: locked, atomic inert planning;
  reruns deduplicate and changed identities quarantine. Never applies to Core.
- `bundle-export SOURCE_DIRECTORY FRESH_DIRECTORY`: validated inert bundle copy.
- `bundle-restore SOURCE_DIRECTORY FRESH_DIRECTORY`: same fresh-copy boundary.
- `ledger-export LEDGER_FILE FRESH_ARCHIVE_FILE`: self-digested ledger recovery.
- `ledger-restore ARCHIVE_FILE FRESH_LEDGER_FILE`: fresh inert ledger recovery.

Create private output parents yourself. No home discovery, database access,
credential transfer, runtime admission, effect dispatch or product restore is
implemented. Runs/timers/routes/approvals remain PAUSED plan entries. Unknown or
conflicting records retain exact source evidence and quarantine reasons. Structural
exclusions are not a secret scanner. Producer consistency receipts are not verified
by contacting a source; real snapshot/export/apply requires Core's reviewed ports.
