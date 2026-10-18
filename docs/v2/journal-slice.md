# First implementation and lane handoff

This fills the previously missing plan link. The first frozen subset is
[event-contract-v1.md](event-contract-v1.md). It is intentionally narrower than M1:
durable metadata graph/tasks, deterministic replay, no real execution or UI server.
Initial scaffold verification: commit `02d607ee`, Rust 1.99.1, formatter, Clippy
with warnings denied, six unit tests and the in-memory demo passed on Linux.
The original scaffold failed `cargo fmt --all -- --check`; formatting was repaired.

## Ordered work and ownership

All branches start from `v2/rust-rewrite`, never main. Coordinator owns the lockfile
and root workspace. One heavy build at a time on the development host; at most two
implementation model turns at once. Existing 1.x workers keep their assignments.

| Lane / branch | First bounded deliverable | Boundary |
|---|---|---|
| Core: `v2/s0-core` | SQLx journal/projection and kill/reopen/idempotency tests | `v2/crates/orkestr-store-sqlite`; schema authority |
| UI: `v2/s0-ui` | Dioxus composer/streaming/reconnect prototype and measured gate report | Isolated manifest/target until reviewed; no DB imports; iOS build blocked on verified macOS/Xcode availability |
| Runtime: `v2/s0-runtime` | Offline adapter protocol/fake busy-session harness | Synthetic events only; no Codex/Claude calls or credential probing |
| Verification: `v2/s0-verification` | Source-backed parity inventory, independent failure review, then copy-only importer | Synthetic snapshot first; no live stores or effects |

A branch receipt is not a running Orkestr thread receipt. Record actual execution
and private thread IDs outside the public repository if managed threads are used.
The durable store can be integrated after independent review; UI/runtime/importer
remain separate PRs until their gates pass. No production release is part of this
work. Dioxus selection is provisional on measured accessibility, streaming and iOS
results, not merely successful dependency resolution.

## Full M1 acceptance still to implement

On a fresh separate local home/port: initialize first admin, connect explicit fake
runtime, create project and main conversation, accept durable input while a deep
session is busy, start an independently supervised fake worker, accept follow-up,
stop it promptly, restart and inspect preserved messages/result evidence. Replay
must not execute effects. Browser composer stays editable during streaming and
cursor reconnect does not duplicate history. None of the initial library tests
alone proves this full scenario, provider support, migration parity or cutover.
