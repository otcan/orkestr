# Independent intake review: core candidate

Core reviewed head: `28c4779346a2d6e46abed5305cd4b6ee7deac060`, PR #78.
This is a partial intake review, not full M1 or full PR approval.

A clean archive of that exact source was built with the host-provided
`v2-cargo build --locked --manifest-path <archived-v2>/Cargo.toml -p orkestr-v2-server`,
using the verification lane's separate target/home. Build passed. No production
profile, provider, credential, channel or 1.x data was used. CI run
[39132698484](https://github.com/otcan/orkestr/actions/runs/39132698484)
was independently queried and its rust-v2 job passed.

Run the independently authored probes against that binary:

```sh
python3 v2/acceptance/intake_blackbox.py \
  --binary /absolute/isolated-target/debug/orkestr-v2-server \
  --home /absolute/isolated-verification-home --port 47140
```

Observed: **4 tests, 3 passed, 1 failed**. This is separate from Core's own
reported seven Python cases and four Rust tests; do not add those counts twice.

| Probe | Observed result |
|---|---|
| Ten concurrent same-key requests, changed-body conflict, SIGKILL/reopen and original receipt replay | Passed; one message/event/inbox/outbox each |
| Client actor spoof, foreign Origin, cookie without Bearer | Passed; no admission |
| SSE Last-Event-ID overrides ahead query cursor; ahead cursor alone requires resync | Passed; expected event identity/sequence |
| Database symlink into separate synthetic legacy home | **Failed; startup remained running and target grew from 0 to 4096 bytes** |

## Blocking isolation finding

`v2/apps/server/src/main.rs` canonicalizes the candidate home and compares it
with the optional legacy home. `Store::open` then follows `core.sqlite3` without
checking its resolved target. Nonoverlapping directories therefore do not prove
nonoverlapping database storage. Reproduction creates only disposable synthetic
directories: candidate/core.sqlite3 points into the synthetic legacy directory,
and the legacy-home environment variable names that directory. Startup must
refuse before opening/migrating the target, including relevant WAL/SHM aliases;
physical aliases/hardlinks need a stated policy. The regression deliberately
fails until Core fixes isolation. It never points at a real legacy home.

## Remaining evidence limits

The 17 broader acceptance inventory scenarios remain pending: these narrow
probes do not close every subcase. Busy fast/deep/worker roles, stale lease,
stop/effect fences, exact approvals and unknown-effect quarantine cannot pass
without runtime/store integration. Cross-owner tests require a synthetic scoped
principal fixture; a nonexistent conversation ID is not cross-owner proof.
Slow SSE consumer memory bounds, multi-page history under concurrent admission,
startup permissions/alias cases, performance and full CI/security/dependency
review remain open. Core's green CI does not waive the isolation failure.

Coordinator must independently review these authored probes at their own exact
head before integration. Runtime's duplicated provisional ports must reconcile
with the shared typed application boundary; spy order is not durability evidence.
