# Intake UI manifest handoff

The authored crate-local manifest is `v2/apps/ui/Cargo.toml`. Coordinator-owned
root change requested: add `apps/ui` to `v2/Cargo.toml` workspace members, then
resolve the authoritative shared lock only after the current owner migration/
review gate permits it. This lane does not create a separate workspace or lock.

Exact new external direct dependency:

```toml
dioxus = { version = "=0.7.3", default-features = false, features = ["macro", "html", "signals", "hooks", "launch", "document"] }
```

Existing dependencies: `orkestr-v2-contracts` at `../../crates/contracts`,
`serde.workspace = true`, and `serde_json.workspace = true`. Package version,
edition and license inherit the workspace. No `gloo-timers` dependency is
requested: the earlier timer proposal was superseded by a platform bridge
Promise timer shared by web and mobile. No archive manifests/lock were adopted.

Crate features are `default = []`, `web = ["dioxus/web"]`, and
`mobile = ["dioxus/mobile"]`. Select exactly one renderer when building the
application. The pure presentation library has no renderer requirement.

Pending validation after shared membership/lock resolution: Rust projection
tests, web build, mobile target compile, dependency/security review, and real
browser/native acceptance. Node bridge tests exercise synthetic fetch responses;
they do not establish a browser login, real API integration or native readiness.
