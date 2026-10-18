# Runtime offline slice (candidate, not M1 acceptance)

The `orkestr-runtime` crate is a test-fixture adapter and bounded supervisor
boundary. It has no database, external effect dispatcher, authentication,
credentials, inference or fallback provider selection. `FakeProvider` requires
explicit fixture selection and labels itself synthetic. It is not a production
runtime. Provider completion proposes evidence; it cannot mark a task succeeded.

## Verification

From the repository root, use the assigned host cargo wrapper and lane-specific
`CARGO_TARGET_DIR` and `ORKESTR_V2_HOME`:

```sh
$V2_CARGO test --manifest-path v2/Cargo.toml -p orkestr-runtime
$V2_CARGO clippy --manifest-path v2/Cargo.toml -p orkestr-runtime --all-targets -- -D warnings
$V2_CARGO fmt --manifest-path v2/Cargo.toml -p orkestr-runtime -- --check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s v2/tools/tests -v
python3 v2/tools/probe_codex.py --scratch-parent "$ORKESTR_V2_HOME/probes"
```

Local run on 2026-10-18: 12 tests passed, zero ignored; crate clippy passed.
Tests cover explicit fixture selection, independent fast/deep/worker progress,
exclusive native session use, stale generation rejection, bounded queues,
stop priority, unsupported operations, protocol identity/status validation,
admission before provider start, explicit started evidence and cancellation
fence before interruption. Ordering tests use a spy, not a durable store.

Four additional Python tests pass with all subprocess calls mocked: the probe
sends only initialize, excludes credential variables and existing profile paths,
refuses version mismatch before launch, kills/reaps its child on timeout, and
does not print raw metadata or RPC errors. These tests launch no provider and
add no Cargo dependencies. They do not change the provider evidence level.

Codex 0.163.0: isolated stdio `initialize` RPC returned successfully. Printed
only version, success and response field names (`codexHome`, `platformFamily`,
`platformOs`, `userAgent`); actual paths and user agent are not retained here.
The probe sends only initialize, then EOF, with fresh temporary HOME/CODEX_HOME
and no inherited credential variables. No thread, turn, auth or model request.
Reference: [official app-server protocol](https://developers.openai.com/codex/app-server/).
Installed behavior takes precedence over newer documentation.

Claude Code 2.1.295: version/help only, with `CLAUDE_CONFIG_DIR` unset. Help
advertises stream-json input/output, resume, session ID and fork support.
No structured process, inference, account or auth check was attempted.

Both JSONL fixture sets contain invented IDs and synthetic output. Codex shapes
follow documented notifications; Claude shapes are candidate fixtures, not a
captured or verified live exchange. Neither fixture is proof of compatibility.

## Pending gates

- Move provisional runtime ports into shared application/contracts after core
  agreement, using canonical typed IDs and owner/scope authorization.
- Implement session/run admission, fence checks and recovery in core's one
  authoritative SQLite store. No runtime-owned persistence is supplied.
- Connect the supervisor to the API/inbox. A stalled fake turn test proves only
  adapter independence, not durable ingress latency or the 30-second UI scenario.
- Verify restart/process failure, idempotent completion, lost-session handling,
  effect quarantine and durable evidence through independent acceptance tests.
- Real subscription-backed Codex/Claude turns, persistent fast/deep sessions,
  resume/fork, containment and actual cancellation remain unverified.

Unsupported resume/fork/steer return a typed blocker. `cancel` persists the
store fence before requesting interruption; interruption failure leaves a
request, never a false confirmation. Exact-head CI and independent review must
be attached to the PR before integration. This document does not claim the
runtime slice, M1 or the Rust rewrite is complete.

## Independent source review follow-up

The source-only review of initial head `0a68f50a` found two P2 races.
The candidate fix preserves queued Completed/Failed/Lost evidence when interrupt
arrives afterward: interruption returns Busy (unconfirmed), and evidence retains
its original admission/generation. No confirmed stop is fabricated.

Supervisor steps now take a caller-retained `PendingObservation`. A non-stale
store error retains the same event under the same admission for retry; success
clears it and a store StaleLease refusal explicitly discards it. A different
admission cannot relabel the retained observation. This is one volatile pending
event per supervised run, not a durable buffer or process-recovery solution.
Core's shared observation port must supply stable event keys/digest replay
checks and typed Unavailable/Fenced errors on migration.

Four regression tests were added: terminal-before-newer-cancel race, fail-once
terminal record retry, explicit stale discard, and no relabeling on retry. The
terminal cases cover Completed, Failed and Lost. Rust formatting passes. The
regression test command via v2-cargo with --locked stopped before compile because
this lane awaits the coordinator-owned lockfile. These new Rust tests are pending,
not passing acceptance. Formal review still needs a distinct reviewer identity;
the shared PR-owning account cannot formally approve its own PR.


Shared-port migration checkpoint:

- Consumed the coordinator combined candidate `aec7475b` by non-force merge.
  At that exact head, the offline locked runtime command passed 16 tests
  (10 protocol/fake, 3 ordering, 3 retry). These are not store durability tests.
- Imported core provider-event additions from `e2de7312` and replaced the
  provisional synchronous store with native asynchronous `RuntimeStore` calls.
  Runtime uses shared UUID IDs and separate lease/fence generations. Provider
  traits, parser and fake remain runtime-owned; no persistence adapter was added.
- Cancellation carries a distinct interrupt-control envelope and returns the
  persisted cancellation receipt even when interruption fails. Its new fence
  cannot become execution admission. Refused stale/fenced observations are held
  for explicit reconciliation rather than retried as newly authorized events.
- The migrated tests use ready-future spies, stable sequence/payload retries and
  typed `Unavailable`/`Fenced`/`StaleLease` errors. They remain unexecuted pending
  the coordinator-owned dependency lock update. No live inference was run.
