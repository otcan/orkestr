# Offline SQLite metadata journal

This crate implements `docs/v2/event-contract-v1.md`, not the authenticated M1
API. It has no network, provider, credential, process dispatch or legacy-home
integration. Supply an explicit fresh **synthetic** database path.

```sh
cargo run --manifest-path v2/Cargo.toml -p orkestr-v2-store-sqlite \
  --example durable -- /tmp/example-v2-journal.sqlite
```

Run again with that same path to observe `duplicate=true` and the original
sequence. Use a path that does not already contain a file on first run.

`Store::append` acquires `BEGIN IMMEDIATE` and atomically commits the versioned
journal record, complete graph/task projection and cursor. SQLx transactions
roll back when dropped or cancelled. Retries compare structural records, not
JSON byte order. `Store::snapshot` reads the persisted projection consistently;
`Store::replay` validates the entire journal before atomically replacing that
projection. `Store::open` validates history but deliberately does not silently
repair independently damaged projection tables. Explicit replay repairs those.
Every write/replay scans all history: this small slice makes no scale claim.

Files use a v2 application ID and schema version 1, WAL, synchronous FULL, foreign
keys and a five-second busy timeout. Unknown versions, altered/unrelated schemas
and pre-existing empty files are refused. Preflight inspects an expendable private
copy of the explicit database and its WAL: SQLite read-only connections can create
sidecars, so unknown source files are never opened in SQLite. No SHM is copied;
the source and its sidecars remain untouched on identity refusal. This is not a
backup/import API. Concurrent initialization/schema replacement or an inconsistent
copy may refuse opening; retry only after initialization completes. An interrupted
first initialization leaves a refused file for explicit inspection, never automatic
adoption/deletion. Existing initialized stores support concurrent writer handles.

The caller must own the path and parent directory. Database/WAL symlinks and
nonregular files are refused; hostile ancestor/path replacement or arbitrary
external schema mutation while open is outside this trusted offline API. Real
data retention, online migrations, authenticated command admission and external
effects require separate reviewed contracts.

Tests use isolated temporary files and actual subprocess SIGKILL with an atomic
checkpoint handshake immediately before/after commit, including lost-ack retry.
The crash hook exists only in unit-test builds; production has no crash-control
environment variables. A Running task is historical metadata, never proof of a
live worker or permission to restart one.
