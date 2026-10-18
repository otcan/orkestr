# Orkestr 2.0 Rust implementation

This directory is reserved for the isolated Rust application. The existing TypeScript/NestJS/Angular implementation remains unchanged outside the v2 track.

## Actual status at plan handoff, 2026-10-18

The branch contains architecture and execution documentation. It does not yet contain a verified Cargo workspace, in-memory demo, server, UI or passing Rust tests. Earlier README commands referring to `orkestr-v2-demo` were premature and have been removed.

The first implementation creates the real Cargo workspace, durable SQLite state, authenticated Axum API, separate session/runtime roles, Dioxus UI and independent acceptance tests. New development threads own that work. Update this file with exact build/test/run commands only after they have succeeded on a specified commit.

## Plan

- [Architecture and technology decisions](../docs/v2/README.md)
- [Full dependency-backed rewrite backlog and new-thread assignments](../docs/v2/workstreams.md)
- [First implementation: contracts, API and acceptance](../docs/v2/first-implementation.md)
- [Local installation, snapshot import and rollback](../docs/v2/migration.md)

Do not point this candidate at the existing application's data, provider sessions, browser profiles or live channel routes. Use a fresh `ORKESTR_V2_HOME` and isolated development worktree. The integration target is `v2/rust-rewrite`, never an implicit merge or release to `main`.
