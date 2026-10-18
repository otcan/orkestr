# Independent fixture transaction checkpoint

Candidate: runtime `ab0039e292cc61a0fccb5b47248b9f20f196940a`, whose complete
store-sqlite source matches Core `c51e5187add1351e47df09835c51e9480e037173`.
This is fixture-only transaction evidence, not production dispatch acceptance.

Independent source review found no blocking issue in readiness, admission,
reservation, consumption, takeover fencing or migration 0004 under the documented
trusted fixture/caller-controlled filesystem assumptions. Admission and exact
inbox consumption share BEGIN IMMEDIATE; reservation verifies the authoritative
envelope and candidate; consume clears locator hashes and commits unknown delivery
before returning DispatchNow. Takeover fences predecessor state in its transaction.
Unavailable lifecycle operations and blocked production starts remain limitations.

## Independently authored and executed checks

`v2/acceptance/fixture_transactions.rs` was installed as
`crates/orkestr-runtime/tests/independent_transactions.rs` in an owned archive of
the exact candidate. No candidate implementation, manifest or lock was changed.
Synthetic per-test databases used the verification lane's isolated home. No HTTP
server, inference or external channel was used.

Required wrapper invocation from that archive's v2 directory:

```sh
v2-cargo test --locked --offline -p orkestr-runtime --test independent_transactions
```

Result: **3 passed, 0 failed, 0 ignored** (0.08s final formatted-source execution).
The wrapper compiled the test target; package formatting and diff checks passed.
This is independent execution of independently authored probes, not adoption of
Core's or Runtime's test counts. No exact-head CI result is claimed here.

Test source SHA256: `adf6f36e665ac802ac06aa7213713060a7b88eb8687944bb349c03cc1b1011b7`.
Executed test binary SHA256: `5382a46d39d68041f5651c7442730ab5b32f9df3629b5f4b163c9c7ceb2b5e3c`.

| Procedure | Observed independent evidence | Remaining acceptance |
| --- | --- | --- |
| R01 | Competing independent pools return one FreshCandidate and one Replay with identical envelope, no replay candidate | Exact run/inbox-ack counts require scoped read-only projection |
| R02 | Changed scope sequence conflicts; changed role/fence and forged locator values refuse; original valid authority still consumes | Full owner/scope/session/generation matrix and unchanged-row projections pending |
| R03 | No independent rollback injection | Pending Core-owned fault harness |
| R04 | Competing reservation returns one locator and one Replay; forged candidate rejected | Changed-key/body matrix and durable reservation projection pending |
| R05 | Competing consumes return one DispatchNow; third independently opened pool sees ReconciliationRequired before any I/O | Read-only durable state projection pending; no provider I/O acceptance claimed |
| R06 | Discard successful consume result, close pools, reattach with original live handle: no candidate/reservation/new DispatchNow | Not transport lost-ACK or process recovery; injected committed-before-reply crash pending |
| R07 | No independent expiry/takeover execution | Pending bounded expiry facility and scoped quarantine projection |
| R08 | Ordinary Store admission is Unavailable; rejected inputs grant no consume permission | Unready fixture/error matrix and unknown-commit injection pending |

All eight full procedures remain **pending**. These three passing probes establish
only their listed observations. Core was directly asked for scoped read-only
run/ack/reservation projections, deterministic fixture expiry, and an opt-in
owned-child rollback/commit-before-reply checkpoint harness. Verification adds no
schema, SQL mutation authority, public recovery constructor or competing store.

## Successor 44ecdb30: projections and opt-in controls

This checkpoint supersedes the missing-facility statements above for the APIs now
provided. Exact Core source: `44ecdb30b28e03b39ccff5509493ca937311a84d`.
An owned archive of that complete v2 tree was used without changing its manifest
or lock. The independent test file was installed under
`crates/store-sqlite/tests/independent_transactions.rs` (it uses only existing
store-package dependencies). No candidate implementation was changed.

Source review found no blocking issue in owner/conversation/context-scoped
inspection or the explicitly enabled `fixture-test-controls` feature. Inspectors
validate the live context and scope within a read snapshot and expose counts,
phases and verifier presence, never locator/native/digest values. Expiry only
shortens the authenticated incarnation's deadline. Checkpoints use create-new
markers and a bounded 30-second wait; reattach does not copy the armed hook.
Caller-controlled stable marker directories remain required.

Required wrapper executions, with verification target and isolated case home:

```sh
v2-cargo test --locked --offline -p orkestr-v2-store-sqlite --features fixture-test-controls
v2-cargo test --locked --offline -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_transactions
```

The supplied Core suite ran before installing the independent test: **19 passed,
0 failed, 1 ignored**. The ignored standalone child entry is launched by three
passing parents covering eight SIGKILL windows. This is independent execution of
Core-authored oracles, not independently authored crash acceptance.

The expanded independent file then ran **5 passed, 0 failed, 0 ignored** (0.11s).
In addition to prior public-API observations:

- R01: exact scoped attempts=1 and acknowledged=1 after competing admission.
- R02: changed semantic input and forged candidate leave the scoped count snapshot
  unchanged; role/fence/reservation forgeries do not consume valid authority.
- R05: a third independently opened pool observes reconciliation before any I/O.
- R06: the opt-in consume-without-reply control returns Unavailable; an independent
  observer sees DeliveryUnknown with both locator verifier flags cleared, and
  retry grants no DispatchNow. This remains deliberate reply suppression, not an
  independently authored transport-crash oracle.
- R07: explicit expiry followed by two independent-pool successor attempts yields
  one winner. The predecessor becomes fenced; the successor sees exactly one
  acknowledged quarantined attempt, no reservation and no verifier flags. Another
  namespace/key remains valid and sees zero attempts in its own scope.

Source SHA256: `cc957bab9025310a402f28bc2c1e3489c37c23bcd3f755246b25847983fc54b8`.
Executed independent binary SHA256: `77a0528483e05967d95bc11929e1a1da6bce66700298e718d25ed6dcddb88244`.
Package formatting and diff checks passed. No CI result or strict clippy rerun is
claimed by this checkpoint.

Full R01–R08 procedures remain pending: independent rollback/SIGKILL authorship,
complete tamper/error matrix, reserved/unknown takeover variants and broader
process recovery are not covered by these five tests. The new controls remove
several facility blockers; they do not make unexecuted cases pass. Production
starts, provider observations, cancellation/recovery and effects remain outside
this fixture evidence. Coordinator review of the authored test delta is required.

### Independently authored process-kill checkpoint

`v2/acceptance/fixture_crash.rs` was separately authored and installed as
`crates/store-sqlite/tests/independent_crash.rs` against the same exact 44ecdb30
archive. The child bootstraps its own synthetic fixture with public APIs and arms
a typed checkpoint. The parent retains its Child handle, bounds marker wait to
10 seconds, verifies exact marker bytes, then kills and reaps that child. RAII
also kills/reaps on failure. No private handle reconstruction or locator transfer
is used. All synthetic directories are nested in the assigned isolated home.

After kill, a read-only SQLite connection with query_only enabled opens one read
transaction over fixture run and inbox acknowledgement rows. It does not open
Store, run migrations or write SQL state. This is a narrowly scoped inspection
of the owned synthetic database, not a new authority or recovery API.

Required wrapper command:

```sh
v2-cargo test --locked --offline -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_crash
```

Result: **1 parent passed, 0 failed, 1 standalone child entry ignored**; the parent
invoked that entry three times. Final execution took 0.11s. Three actual owned
process SIGKILL observations are independently authored:

| Window | Exact read-only observation after kill |
| --- | --- |
| AdmitBeforeAck, after run insertion | Zero runs and zero acknowledged inbox rows |
| AdmitAfterCommit, before reply | One run and one acknowledgement; Candidate, candidate verifier present, reservation verifier absent |
| ConsumeAfterCommit, before reply | One run and one acknowledgement; DeliveryUnknown, both locator verifiers absent |

This adds independent process-kill evidence for the R03 rollback and R06
commit-before-reply windows, separate from earlier deliberate reply discard and
pool reopen. It does not establish post-process-restart authority, provider
execution/no-redispatch integration, retry after rollback, all reserve windows,
or full R01–R08 acceptance. No provider is invoked by this test.

Source SHA256: `2a247a55f4be1fd7c102b01caeb54e9ebebf01322d203885033e9f3571004004`.
Executed binary SHA256: `f3081b4617336073430edbd6abfd6a2b184a6c2c846cbdf77d941daf5b4e6b10`.
Independent coordinator review remains required; these are author-executed results
for independently authored verification tests, not self-approved test correctness.
