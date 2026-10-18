# Dioxus spike: bounded synthetic streaming client

Tracking: V2-040 / #72. This is an isolated prototype in
`v2/spikes/dioxus-ui`, not M1, not a connected application, and not an alternative
to the public contracts in [first-implementation.md](first-implementation.md).
The separate manifest/lockfile avoid concurrent ownership of the main workspace.
Coordinator must integrate shared DTOs before this consumes the real server API.

## Implemented boundary

- Dioxus 0.7.3 facade with compatible 0.7.10 component crates resolved and
  pinned by the isolated lockfile; web shell with a permanent synthetic-only notice.
- A synthetic event every 250 ms; controls pause, disconnect, replay from cursor,
  or load a 10,000-event snapshot while retaining only the last 50 events.
- Composer edits independent of stream events; draft survives fixture reconnect
  and resnapshot. Submit observes in-memory text only and deliberately does not
  show durable acceptance. Page reload loses the draft, explicitly disclosed.
- Duplicate identical events within the retained window are ignored. Changed
  replay, unverifiable old replay and gaps require explicit snapshot resync.
  Stale, gapped, oversized or malformed snapshots cannot replace current state.
- Ordinary labeled textarea/button semantics; Enter remains a newline rather than
  an IME-sensitive key interceptor. Event stream has live announcements disabled;
  bounded status exposes connection/cursor state. These are design choices,
  **not** proof of screen-reader/keyboard/IME acceptance.

The client fixture is not a persistence layer or authorization boundary. Its
`FixtureEvent` is deliberately named and cannot substitute for the full scoped
M1 event envelope. It contains no credentials, Orkestr database/runtime dependency,
provider calls, channels or actual task/effect controls. Framework transitive
dependencies are recorded in its isolated lockfile; no Orkestr store or privileged
runtime crate is linked. It neither imports nor
reinterprets the journal slice's graph as UI navigation. One Assistant fixture is
visible; project navigation awaits the real public contract.

This window is not virtualized/paginated history. The large-snapshot button
constructs only 50 visible rows; it does not claim to render or fetch 10,000 DOM
nodes. The pure test traverses 10,000 synthetic records and checks bounded state.

## Local commands

Run from the repository root with the pinned Rust toolchain:

```sh
cargo fmt --manifest-path v2/spikes/dioxus-ui/Cargo.toml --check
cargo test --manifest-path v2/spikes/dioxus-ui/Cargo.toml --locked
cargo clippy --manifest-path v2/spikes/dioxus-ui/Cargo.toml --locked -- -D warnings
cargo check --manifest-path v2/spikes/dioxus-ui/Cargo.toml --locked \
  --features web --target wasm32-unknown-unknown
```

The last command requires `rustup target add wasm32-unknown-unknown`. A successful
WASM check compiles the component/handlers, not a launchable bundled client.
Serving with a compatible `dx serve --platform web --features web` from the spike
directory still requires Dioxus CLI bundling and a separately authorized managed
browser/desktop lease for browser acceptance. No server was started by this lane.

## Host and early iOS feasibility

The inspected host is Linux x86_64, kernel 6.8.0-142-generic, Rust 1.99.1.
`xcrun` and `dx` are absent. Initially only the Linux Rust target was installed.
An iOS simulator build cannot be performed here: an authorized macOS builder with
Xcode/iOS SDK, simulator runtime, compatible Dioxus CLI and Apple simulator Rust
target is required. No Apple signing credential is necessary for the first
unsigned simulator probe; on-device signing/auth tests are later distinct gates.
The spike has a web feature only. Adding a mobile feature/build artifact is
pending the macOS probe; a WASM compile must never be relabeled iOS success.

Dioxus uses its supported WebView-based mobile path, not native UIKit components.
The [official platform guide](https://dioxuslabs.com/learn/0.7/guides/platforms/)
describes feature-selected targets; the
[0.7.3 crate documentation](https://docs.rs/crate/dioxus/0.7.3) is the pinned API
reference used by this spike.

## Remaining measured acceptance gates

1. Bundle/launch under a managed browser lease; actual DOM editability for 30 s
   while streaming, focus/selection stability, reconnect and bounded rendering.
2. Turkish/Japanese/emoji IME composition, paste, multiline behavior, persisted
   drafts and keyboard controls; controlled textarea behavior must be measured.
3. Screen-reader order/live-region rate, keyboard-only use, contrast and zoom.
4. Real authenticated M1 DTOs/SSE, explicit stale-cursor snapshot response,
   bounded server buffering, command errors and durable acceptance/reload.
5. macOS iOS simulator compile/run, navigation, suspend/reconnect and keyboard;
   separately, signed device auth/keychain/accessibility/transport tests.

No acceptance target has been weakened by this prototype. M1 remains incomplete
until the real API/state/runtime and full acceptance scenarios pass.

## Executed evidence (2026-10-18)

On the Linux host above, with two Cargo build jobs and a separate target directory:

- `cargo fmt --check`: passed.
- Locked pure Rust tests: **6 passed**, including the 10,000-event bounded-state
  case, cursor gaps/replay conflicts, snapshot validation and Unicode draft
  preservation. First run including compilation: 0.81 s; max RSS 143,176 KiB.
- Locked default-feature Clippy, all targets, warnings denied: passed (0.38 s).
- Locked `wasm32-unknown-unknown` web check: passed (46.69 s including fresh
  dependencies; max compiler-process RSS 512,996 KiB).
- Locked web-feature WASM Clippy, warnings denied: passed (0.43 s).

These times measure fixture compilation/testing only, not rendered input latency,
application receipt latency or memory of a running browser.
