# Orkestr 2.0 Rust implementation

This directory is reserved for the isolated Rust application. The existing TypeScript/NestJS/Angular implementation remains unchanged outside the v2 track.

## Verified initial implementation, 2026-10-18

The Rust workspace now contains the pure domain, in-memory CLI demo and a durable SQLite journal with replayable graph/task projections. The independently reviewed store revision `ef759a48f9d6861b05165f726e2afe2837acaf6e` passed formatting, strict Clippy and 25 tests on Rust 1.99.1. Tests include real subprocess termination before/after commit, lost-acknowledgement retries, competing writers, cancellation and rollback after projection failure. Its durable demo reopened the same database and returned the original sequence with `duplicate=true`.

From `v2/`, the verified commands are:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo run --locked -p orkestr-v2-demo
cargo run --locked -p orkestr-v2-store-sqlite --example durable -- /tmp/orkestr-v2-demo.sqlite
```

Use a fresh, explicitly chosen demo database path. Repeating the last command checks idempotency; it does not execute external actions. Read the [store limitations](crates/orkestr-store-sqlite/README.md) before using the library. This is trusted offline metadata storage, not the authenticated M1 execution authority.

The separate [Dioxus fixture spike](../docs/v2/dioxus-spike.md), revision `dcf099b1f2086ed59ed5764114c70201dcb323fa`, passed six fixture tests and the WASM web build/check. Browser input/IME, accessibility and iOS gates remain unverified. There is no integrated UI/server or verified provider adapter yet. The authenticated Axum API, admission/evidence contracts and supervised runtime remain work for the managed v2 lanes.

## Plan

- [Architecture and technology decisions](../docs/v2/README.md)
- [Full dependency-backed rewrite backlog and new-thread assignments](../docs/v2/workstreams.md)
- [First implementation: contracts, API and acceptance](../docs/v2/first-implementation.md)
- [Local installation, snapshot import and rollback](../docs/v2/migration.md)

Do not point this candidate at the existing application's data, provider sessions, browser profiles or live channel routes. Use a fresh `ORKESTR_V2_HOME` and isolated development worktree. The integration target is `v2/rust-rewrite`, never an implicit merge or release to `main`.
