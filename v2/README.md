# Orkestr 2.0 Rust intake increment

Owner-authorized provider changes and carried context are documented in
[Provider handoff](docs/provider-handoff.md).

The first core increment provides a real Axum server with authenticated local
projects, one global/project conversation, transactional SQLite admission,
paginated history and cursor SSE. It does not run models or workers. Project
Git resources are not provisioned and local OXRM remains unverified. Full M1,
UI/iOS, runtime, effects, approvals and live-provider acceptance remain pending.

Requirements: Rust **1.99.1**, Python 3.11+ for HTTP/process probes, a C compiler
for bundled SQLite. Run from this directory. The development host must use its
assigned `v2-cargo` wrapper and lane-specific target/home; replace `cargo` below
with that wrapper on the shared host. Never use legacy data/session directories.

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo build --locked --workspace
ORKESTR_V2_HOME=/absolute/fresh/test-home cargo test --locked --workspace
python3 tests/check_boundaries.py
```

Tests include published JSON fixture roundtrips, invalid actors/IDs, duplicate
concurrent ingress, body conflict, forced transaction rollback, SIGKILL/restart
with receipt/history recovery, auth/origin rejection, project idempotency,
pagination and SSE replay. Process probes reserve port 47110 by default; set
`ORKESTR_V2_TEST_PORT` to a free assigned lane port. No providers are invoked.

To run the local candidate, create an isolated private home and provide a fresh
random bootstrap token through the environment (at least 32 characters). Never
put the token into a public file, transcript or committed shell command.

```sh
export ORKESTR_V2_HOME=/absolute/fresh/private-v2-home
export ORKESTR_V2_BIND=127.0.0.1:47110
# Set ORKESTR_V2_BOOTSTRAP_TOKEN privately before starting.
cargo run --locked -p orkestr-v2-server
```

The executable requires a loopback address, rejects configured `ORKESTR_HOME`
overlap after canonicalization, and never reads legacy/provider state. Operators
must select a fresh private home; this is not a general filesystem sandbox.
A bearer token authenticates HTTP clients; setup uses the bootstrap header.
See [API v0 intake](../docs/v2/api-v0-intake.md) for routes and authentication.
SQLite migrations live in `crates/store-sqlite/migrations`; database schema changes
belong to Core. The coordinator integrates workspace membership and lock changes.

The domain imports no adapters. Application exposes the transactional port;
store-sqlite implements it; server composes them. Shared web-safe DTOs live in
`crates/contracts`; examples live in `fixtures`. The in-memory domain demo is
preserved as an offline reducer smoke check; it does not prove runtime behavior
or durable acceptance.

Builds and tests are evidence for this increment only. No deployment, migration,
external connection, live-provider verification or production readiness is implied.
