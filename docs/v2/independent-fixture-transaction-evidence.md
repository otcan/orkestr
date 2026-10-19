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

### Refusal matrix and seven independent kill windows

The next checkpoint still targets exact Core 44ecdb30; it changes only independent
tests and this evidence. Install `fixture_negative.rs` as
`tests/independent_transactions/negative.rs` beside the two integration test files.
The main transaction file loads that purpose-specific module. Commands remain
locked/offline through the required wrapper, adding both `--test
independent_transactions --test independent_crash` to the store feature invocation.

Result: **7 transaction tests passed** (0.21s); **1 independent crash parent
passed** (0.28s), **1 standalone child entry ignored** and invoked seven times.
The independent parent now covers every public typed checkpoint:

| Kill window | Post-kill read-only durable state |
| --- | --- |
| AdmitBeforeAck / AdmitBeforeCommit | 0 runs, 0 acknowledged rows |
| AdmitAfterCommit | 1 run/ack, Candidate, candidate verifier only |
| ReserveBeforeCommit | 1 run/ack, Candidate, candidate verifier only |
| ReserveAfterCommit / ConsumeBeforeCommit | 1 run/ack, Reserved, both verifiers present |
| ConsumeAfterCommit | 1 run/ack, DeliveryUnknown, neither verifier present |

The new negative module independently tests 14 synthetic returned-envelope
mutations at **both** reserve and consume: owner, conversation, session, role,
purpose, lease generation, dispatch fence, attempt, deadline, native identity,
binding generation/role/state/native identity. Every operation refuses; scope
counts or the attempt projection remain unchanged after each rejection. A valid
reservation/consume still succeeds afterward. A different reservation request
key conflicts. Seven pre-admission claim mutations (owner, conversation,
consumer, generation, sequence, deadline, expected binding generation) each refuse
with the scope still at zero attempts. Fast-role readiness and unsupported protocol
confirmation refuse. These are explicit cases, not an exhaustive error matrix;
the test name's "unready_protocol" label refers to readiness protocol refusals,
not an unconfirmed deep binding admission test.

Current procedure coverage, **without declaring full procedures passed**:

| Procedure | Completed independent cases | Still pending |
| --- | --- | --- |
| R01 | Admission race, same envelope, one fresh locator, exact 1 run/ack | Wider concurrency/repeated schedules |
| R02 | 14 envelope mutations at reserve/consume; 7 claim mutations; unchanged projections | Explicit message/event tamper, cross-project existing-ID cases, remaining binding fields |
| R03 | Actual kill after insert-before-ack and before commit yields 0 run/ack | Public-authority retry after child loss; full unrelated-state retention |
| R04 | Reservation race, forged candidate, changed key, before/after-commit kills | Replay after reservation child loss cannot be authorized by IDs alone |
| R05 | Consume race, third-pool unknown observation, before-commit rollback and after-commit unknown | Provider-integrated execution acceptance |
| R06 | Suppressed reply, live-handle pool reopen, actual consume-commit-before-reply SIGKILL | Public process-restart recovery and integrated no-redispatch oracle |
| R07 | Reserved predecessor expiry race, quarantine/verifier clearing, unrelated namespace remains live | Candidate and DeliveryUnknown predecessor variants independently authored |
| R08 | Ordinary admission unavailable, fast readiness/protocol refusal, tamper fail-closed | Unconfirmed deep binding and remaining unavailable/error paths |

Core was notified of this matrix to coordinate its separate meaningful guard
tests. No implementation defect was observed in this bounded execution. Existing
private Core crash tests and Runtime tests retain their separate evidence status.
Coordinator review of these new authored changes remains required.

Current source SHA256 values:

- main: `bfb7378d7a69710f11435ba9e9fe0e4b5a1ffa250e04dca79c5e037e939a12b3`
- negative: `c14082a546a3b843c3ee00521fed65c287d9fc15976fb8f0af0c97d0a49ec7e4`
- crash: `4fa70ea39ece0195d76d650adff352c9391da00adbc400f6b98119e15a346be2`

Executed binary SHA256 values:

- transaction: `0a917e58f762695303ea0ee19d215dbde035242d50e2e579859a5c870035e6bb`
- crash: `19f6a4070c521be98dd0ced55f278e0e2a431b3e7eaeb4628426961feb9a0c6d`

Strict clippy also passed for both independent integration targets, using the
required wrapper with `--locked --offline -p orkestr-v2-store-sqlite --features
fixture-test-controls --test independent_transactions --test independent_crash
-- -D warnings`. Package formatting and git diff checks passed. No exact-head CI
result is claimed for this verification update.

### Existing cross-project IDs and unconfirmed deep readiness

Two more independently authored probes run against the unchanged exact Core
44ecdb30 archive. No Core df911ff7 guard test was imported or counted as these
independent probes. Same wrapper command and isolated target/home as above:
`test --locked --offline -p orkestr-v2-store-sqlite --features
fixture-test-controls --test independent_transactions`.

Result: **9 transaction tests passed, 0 failed, 0 ignored** (0.21s). Strict clippy
for that integration target, package formatting and diff checks also passed.
The crash file is unchanged; this update does not claim a new crash-suite rerun.

- **R02 existing cross-project identifiers:** two actual projects under the same
  synthetic owner each receive a message, event, readiness-confirmed deep binding
  and live claim through public APIs. Substituting project B's message ID, event
  ID, or both into project A's claim refuses with StaleLease before admission and
  Conflict after admission. Both projects' scoped projections remain unchanged
  after every refusal; B has no attempt for that request key. Original A and B
  claims each still admit/reserve/consume using their own authority. No invented
  foreign identifiers are used in these six substitutions.
- **R08 unconfirmed deep binding:** a real project gets an unconfigured Starting
  deep binding and a live claim. Two admission attempts return Unavailable, with
  zero attempts/acks and no attempt inspection result. Explicit readiness
  confirmation then allows the **same original claim and request key** to admit,
  reserve and consume. Refusals therefore did not spend the claim or issue usable
  attempt authority.

These specifically complete the previously listed cross-project message/event
and unconfirmed-deep-binding cases. R02's remaining binding-field/error matrix,
R08's other unavailable/error paths, process recovery and broader lifecycle
acceptance remain pending. Runtime separately owns Candidate/DeliveryUnknown
predecessor takeover variants; no credit is transferred from that lane here.
No guard defect was observed. Independent coordinator review is requested for the
new authored delta, and no CI result is claimed.

Current source SHA256:

- main: `66483bed24d538cd1161bba7fbe31380b24077e1e2b9463fe8595ad87a256226`
- negative module: `3c9518ace24b4bf6bed160880be7b7cbccda5c0c28c624fbc449f4d1a219714a`

Executed transaction binary SHA256:
`582316f4ffbe88b5c20639eeff96c642b620bd14800f563266d610f954ec3968`.

## Observation adapter checkpoint: 002270e0

Independent candidate source: Core `002270e03abfcc642b80e3face4c8347699527a5`
(PR78), including canonical DTO bf87414f and migration/append cff94b88.
The verification lane exported that exact v2 tree into an isolated candidate
workspace, retaining its manifest and lock unchanged, then installed the authored
transaction/negative/observation integration-test modules. Synthetic owned homes
only; no server, provider or production activation.

Required wrapper commands (from the exported v2 workspace, with assigned
verification target/home):

- `v2-cargo test --locked --offline -p orkestr-v2-store-sqlite --features fixture-test-controls`: **34 passed, 0 failed, 1 ignored child entry**; the core-authored crash parents invoke that child. This is independent execution of core-authored tests, not independently authored acceptance.
- `v2-cargo test --locked --offline -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_transactions`: **11 passed, 0 failed, 0 ignored** (0.52s), including nine earlier transaction checks rerun on this candidate and two newly authored observation tests.
- `v2-cargo clippy --locked --offline -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_transactions -- -D warnings`: passed.
- Wrapper package formatting and `git diff --check`: passed.

New authored source: `v2/acceptance/fixture_observations.rs`, SHA-256
`273110b6cbc7045bcebee9a79fabea36794f34427677b3def4f97aece9567b1f`.
Executed independent-test binary SHA-256:
`4516582987cbff4c0690d45cf1b740527576ccf8c2200c97f03536479d5422b7`.

The first new case races identical Started observations across independent pools,
requires one original receipt and one duplicate, then appends non-synthetic
CompletedProposal and checks canonical sequences 1/2/3 with distinct metadata and
original source linkage. After deterministic expiry/exact predecessor takeover,
both original and successor handles replay the original Running receipt; changed
Stopped replay conflicts and unseen evidence is refused. Full-row read-only
snapshots show these retries/refusals do not mutate durable rows.

The second injects SQL trigger failures at event insertion, observation insertion,
outbox insertion and run projection update. Each refusal preserves every column
of conversations/events/outbox/observations/runs/inbox/bindings in a single
read-only snapshot transaction; retry starts at run sequence1/conversation
sequence2 and transitions Starting directly to Failed. A real next inbox claim
then receives Busy without durable mutation, proving this slice grants no reuse.
Private values are compared only in memory and never printed.

No blocking bounded source finding was identified in migration/append/replay.
The independently rerun core suite includes populated prefix4 foreign-key/checksum
upgrade and failed copy-rehearsal live-WAL preservation checks. These migration
cases remain core-authored. New observation tests use SQL failure injection and
controlled expiry, **not observation SIGKILL, transport lost-ACK, or process
recovery**. Independent migration fixture construction, observation crash windows,
broader adversarial matrices, live browser mixed replay, lifecycle/effects and
production dispatch remain pending. No CI result or blanket acceptance claimed.
