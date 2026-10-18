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

## Read-only archive comparison and CI count verification

Archive `ef759a48f9d6861b05165f726e2afe2837acaf6e` was inspected as reference
only. Its reported 25 tests were not rerun and are not managed-core evidence.
No archive store code was copied. Comparison is against core
`f8e1af18b5c88df753623e3a69f7240f56080a0e`; its store-open implementation is
unchanged from the tested intake head above.

| Valuable negative case from archive | Managed-core evidence / next probe |
|---|---|
| Foreign schema, future version, altered accepted schema refused without changing database or sidecars | Pending. Core opens a writable WAL pool before SQLx migrations; no explicit application identity/schema preflight is present. Assert byte-for-byte preservation on refusal, including an unrelated database whose tables do not collide with migration names. |
| Future version present only in uncheckpointed WAL | Pending. Refusal must inspect the effective database, not just the main-file header; preserve live WAL/SHM and keep the synthetic writer open. |
| Database symlink refusal | Independently failed as recorded above. Add sidecar and physical-alias cases under an explicit policy. |
| Crash before commit and after commit before acknowledgement | Pending at those precise boundaries. Existing kill-after-receipt coverage does not establish either boundary. Require deterministic test-only handshakes; no timing-based assumption. |
| Projection write failure rolls back journal/projection | Core's inbox-trigger failure covers a related admission transaction rollback; not runtime projection recovery. |
| Corrupt/future journal records preserve prior projection; wrong worker and competing claims fail atomically | Pending runtime/recovery schema and typed-store implementation. Do not map archive task semantics onto intake-only tables. |
| WAL/FULL/foreign-key policy on actual store connections | Configured in source. An external SQLite connection cannot verify another connection's FULL/foreign-key settings; own-handle evidence remains needed. |

CI run 39132698484 was independently queried: completed/success, exact head
`28c4779346a2d6e46abed5305cd4b6ee7deac060`. Job 117690927129 logs confirm
one domain test, two fixture tests and one process-runner test: **4 Rust tests**.
The runner logs **7 Python tests, OK**. These are nested counts, not 11 independent
acceptance cases. The successful run does not cover the later interface commit.

Authentication scrutiny found owner identity derived from the authenticated
Bearer session, hashed expiring session storage, bootstrap gating and rejected
actor injection. Independent narrow auth probes passed as recorded above.
Cross-owner fixture coverage, browser/device session persistence/revocation and
transport-level slow-header limits remain pending; none is implied by a green
intake CI. M1 remains pending.

## Independent fixed-candidate rerun

The preceding failure is historical. On 2026-10-18, independently built exact
PR #80 candidate `e61cf8956c4ef3ef0aa905325516a5d4b5e5f5ed` from a clean
source archive with the required host wrapper:

```sh
CARGO_TARGET_DIR=<verification-target> ORKESTR_V2_HOME=<verification-home> \
  ORKESTR_V2_BIND=127.0.0.1:47140 \
  <host-wrapper>/v2-cargo build --locked -p orkestr-v2-server
```

Build passed in 6.68 seconds. Binary SHA-256:
`fe45119b90135d96a04e306c01ca3cc5b5ae078f0e0862ec71aae11c75060727`.
Ran the unchanged independent probe source at
`43f6f7332235b04ee7c31e74f9ee0f553725b8a1` using the command above,
an owned isolated home, and port 47140: **5 tests passed, 0 failed**, 7.806 seconds.

Both database-symlink refusal cases passed: empty synthetic legacy database and
live-WAL synthetic database. The latter holds its SQLite writer open through
assertions. Bytes, existence and link snapshots before startup, while the owned
child is still observed, and after child cleanup remained unchanged, including
WAL/SHM where present. The other three probes (concurrency/conflict/reopen,
spoof/Origin/cookie authority, and SSE cursor precedence) also passed.

This closes the independently reproduced database-alias P1 for this exact
candidate under the controlled-parent assumption. It does not independently
execute every core-authored hardlink/sidecar scenario or establish safety against
concurrent filesystem replacement. Foreign/future/altered database identity,
precommit/lost-ack crash boundaries, runtime durability, browser cookie/CSRF and
other acceptance remain pending. No CI run or broader test-suite execution was
performed in this bounded rerun. The heavy slot was released after these probes.
