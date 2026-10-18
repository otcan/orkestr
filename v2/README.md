# Orkestr 2.0 Rust workspace

This path is the isolated Rust v2 implementation. The 1.x TypeScript/NestJS/Angular system is unchanged.

Current scope: pure in-memory conversation/task event reducer, a CLI smoke demo and deterministic tests. **No storage persistence, HTTP server, providers, workers, integrations, auth or UI yet.** Do not mistake a passing smoke run for migration readiness.

Run:

```sh
cd v2
cargo test --workspace
cargo run -p orkestr-v2-demo
```

For goals, boundaries, milestones, and local rollout, read [docs/v2/README.md](../docs/v2/README.md), [workstreams](../docs/v2/workstreams.md), and [migration](../docs/v2/migration.md).
