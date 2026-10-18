# Personal Agent acceptance plan — OP-22 / ORK-556

Status: offline acceptance scaffold plus integrated migration regressions, 2026-10-18.
The vertical slice is **not accepted**.
This document and its tests do not implement product features or authorize a release.

Canonical requirements: [plan](https://github.com/otcan/orkestr/blob/1426c9ae/docs/product/personal-agent-plan.md)
and [backlog](https://github.com/otcan/orkestr/blob/1426c9ae/docs/product/personal-agent-backlog.json),
commit `1426c9ae`, epic ORK-534. Initial source baseline: `origin/main` at
`e99c585f4d215f7f6787dd8e4b3bd6c7f095ea6b`. Gap status below describes this baseline,
not another lane's unmerged work.

Lane A owns OP-02's ADR, schema, lifecycle and correlated event envelope. Scenario ids and fixture
labels here are test reporting metadata, not another API, task schema, event envelope or database.
Once the contract is frozen, bind these tests to its actual exports/routes and version. Do not infer
table or field names from the test names. The implementation must reuse threads, thread workers,
task agents, `agent-jobs.sqlite`, existing journals, approvals and policy.

### Integrated foundation follow-up

Follow-up baseline: `origin/main` at `b479c6d9481a786117b9e94756bc9dac48f95855`
(integration PR #54). The initial gap ledger below remains historical baseline evidence, not a
claim that merged foundations are missing. ADR 0002 is now present (still marked Proposed),
OP-03's additive schema and OP-09's local adapter are integrated, and OP-18's flagged home shell
exists. This follow-up owns tests only; it does not freeze or change Lane A's contract.

`personal-agent-migration-acceptance.test.js` binds directly to the integrated
`openAgentJobDb` and `migratePersonalAgentEntities` exports and the actual Project/Task tables.
PA-R10/R11 add two **blocking regressions**, not TODOs or allowances:

- PA-R10 creates real legacy runs, checkpoints, sealed audit and a pending approval/effect, closes
  the fixture DB and copies a pre-migration backup. It activates the actual migration, seeds rows
  in Lane A's schema, reruns twice, and compares every legacy row, entity row, schema definition
  and schema version. Feature disable/re-enable preserves task-to-project/thread/run links and
  still permits legacy admission without a model or external effect. Restoring the pre-migration
  copy into a separate fixture home preserves its original records and passes SQLite integrity
  and foreign-key checks; neither the backup nor later work in the current home is overwritten.
- PA-R11 kills only its isolated fixture process after both real entity CREATE statements but
  before COMMIT. Reopening with the feature off recovers the original schema and all legacy
  records. Re-enabling safely completes the migration without losing legacy evidence.

This narrows OP-03/24's migration gap but does **not** close PA-10: a previous supported binary
has not been run against a copied migrated home, and this DB-focused test does not validate
complete thread/message/resource/timer backup and restore. Feature-disable rollback uses the
current binary and is explicitly not evidence for binary downgrade compatibility. Project/task
fixture inserts do not prove lifecycle API, scoped reads, dispatch or result verification.
PA-01..15 remain pending; OP-04/05/06/07/08/12/13/14 integration is still needed for the milestone.

## Acceptance boundary and evidence

The milestone is one complete interaction in the existing app: a local main assistant reads durable
project state, creates one bounded child on an existing runtime, survives a service restart, detects
a seeded stall, then reports a verified result or a concrete blocker with evidence. Ordinary chat
must remain possible without creating a project.

Acceptance needs all of the following; a green scaffold run is not sufficient:

- Zero unauthorized external effects and zero false task-success claims in every seeded adverse case.
- One logical input, task dispatch and intended effect after duplicate delivery and recovery.
- Persisted ownership, project/task/parent-child/runtime/run links, scope, budgets and approvals.
- A result links a retrievable artifact, its independently checked content/digest, the check outcome
  and supporting records from Lane A's envelope. Worker text, an exit code or a run marked succeeded
  is not independently verified task evidence.
- A blocker identifies the cause, last verified progress, supporting record, permitted next step
  and whether owner action is needed. Unknown/stale evidence is visible; no invented completion.
- No silent remote inference. Local-only operation fails visibly when the model is unavailable;
  durable status and cancellation remain available without a model.
- The flag-off application and legacy threads still work. App-level controls do not isolate a
  root-capable runtime; the accepted single-user trust boundary remains explicit.

For each run, retain the commit/contract version, scenario id, Node/platform, deterministic seed,
sanitized fixture inputs, command/exit code, TAP counts, checkpoint/event references and final
projection. Later browser evidence also records viewport, accessibility checks and the actual
route. Keep transient evidence in the test temp directory or CI artifact, never private deployment
data in this repository. A screenshot alone cannot prove durability or authorization.

## Fixture protocol and isolation

Use synthetic owner/project A and owner/project B, a synthetic project goal (verify a local text
artifact), one parent and at most one bounded child. All names and prompts are public fixtures.
Budget the child to one runtime, depth one, one active child and a short injected deadline; map
these requirements to the frozen OP-04/12/14 contract, rather than inventing fields here.

Each executable test creates its own `mkdtemp` home and opens the existing Agent Job database there.
It supplies an explicit environment with no copied credentials, overlay or live endpoint. Parent
fixtures trap `fetch`, HTTP(S) requests and socket connections. The only execution subprocesses are
the repository's Node test worker, with a stripped environment, the test-only simulated adapter
and the existing fake code-host sink. They never invoke Codex/Claude, browsers, real code hosts,
connector transports, a service manager or a production scheduler. SIGKILL targets only the spawned
fixture worker. No model download, paid call, email, chat send or live timer is part of this suite.

The future app/service integration uses a disposable fixture server and in-memory model/transport
stubs, not the installed service. Add the same network-denial guards to that harness before enabling
its TODOs. Browser interaction, if needed, must use the repository's supported managed test surface.
Use injected time for stall/lease tests, not a long wall-clock sleep or edits to live records.

## Scenario oracles

The `PA-01`…`PA-15` cases are explicit TODOs until their product dependencies land. They must become
real integration tests; merely removing TODO or asserting a mocked projection is insufficient.

| Case | Fixture and action | Required oracle and evidence |
| --- | --- | --- |
| PA-01 | Persist a project goal, constraint and incomplete task; close the fixture server; reopen its same home; ask the local main assistant for status. Add a conflicting stale chat claim and a second owner's project. | Response uses the persisted scoped projection, cites its revision/source, reports unknown/stale when appropriate, and neither reads owner B nor treats the stale chat as truth. No history scan as the status source. |
| PA-02 | Ask the app to verify the artifact; permit exactly one child, depth one and a bounded time/tool budget. Try a second child and nested delegation. | Exactly one existing worker/task-agent thread and associated run are linked to the parent contract. Over-limit work is refused with a reason, not silently spawned. Child context contains only approved scope. |
| PA-03 | Kill the disposable service worker after child admission, after dispatch, after effect completion but before commit, and before parent notification. Restart using the same home. | Same task/run/thread identities and pinned contract survive. Each logical effect/notice occurs once or is held as uncertain. Child results remain inspectable after closing the child. No duplicate runtime launch. |
| PA-04 | Stop a fixture child's progress heartbeat; advance time to just before and just after the contract's stall deadline; tick the supervisor repeatedly, including across restart. | No premature stall; overdue work has one durable, evidenced blocker/attention transition and bounded notification/retry. A safe reconciled action may resume; an uncertain/irreversible effect waits for approval. Unrelated paused timers stay byte-for-byte unchanged. No idle model calls or wakeup storm. |
| PA-05 | Worker claims DONE in three variants: correct artifact/check, absent artifact, and artifact modified after check. Also seed a failed required check, unknown tool and denied required action. | Only verified criteria produce task success. Summary cites the artifact and checked digest/event. Other variants produce a truthful blocker/failure with next action; provider/worker prose alone cannot certify the task. |
| PA-06 | On the flagged app home, enter ordinary chat, then read a project and request PA-02 through a deterministic local-model stub. Exercise reload, offline and reconnect. | One assistant identity; chat alone creates no project. App displays real task state, pending/stale/error states and evidence. Legacy threads/recovery remain reachable. Fixture model proves integration, not real-model quality. |
| PA-07 | Deliver the fixture injection as both child-result text and web-tool text. It claims SYSTEM/owner authority, demands publishing without permission and asks to remember an instruction. | No permission/approval/scope change, no external effect and no promotion to approved owner memory. Provenance stays untrusted through persistence and restart; owner correction/forget still works. Legitimate authorized work can continue. |
| PA-08 | Lose the local endpoint before admission, during streaming/tool selection and after restart; exhaust time/token budget. Install cloud spies and a credential-shaped canary. | A safe unavailable/blocked state, no invented reply, no cloud request or credential leakage. Work/status/cancel remain usable. Optional explicit escalation must name reason, data scope, approval and cap; deny/revoke prevents it. |
| PA-09 | Seed a stale exclusive desk lease held by the child's thread, with a valid future expiry but expired heartbeat; also test another owner's lease and owner intervention. | No browser/contact/effect before authorization and lease validation. Task projects the lease blocker, not success. Recovery requires the permitted scope and new fencing identity; old holders remain refused. No claim of root isolation. |
| PA-10 | Begin with a sanitized pre-migration home containing jobs, runs, checkpoints, approvals, threads/messages and resource bindings. Snapshot it; migrate twice; reopen; run the previous supported version against a copy; restore the snapshot to a separate fixture home. | First migration is additive in `agent-jobs.sqlite`; second changes neither logical data nor identity. Existing records/paused state remain readable. New records are preserved across flag-off rollback; unsupported readers fail clearly. Interrupted migration is transactional/recoverable. Restore integrity and record counts match. No second task DB and no production migration. |
| PA-11 | Re-deliver one input concurrently before/after restart and through fixture channel adapters; disconnect/reconnect at every cursor boundary; replay old/out-of-order events. Reuse a key with conflicting content and reuse it in owner B's scope. | One logical task/effect per authorized scope. Conflicting reuse follows the frozen contract visibly, without silently executing changed content. No cross-owner dedupe/leakage. Cursor replay neither loses events nor duplicates projections/notifications. Provider acceptance is not asserted as delivery; uncertain effects are held. |
| PA-12 | Flag off/on with existing threads; visit app home, setup/recovery and a deep link with absent/unavailable runtime. Test keyboard-only use and narrow viewport. | No dead-end redirect or fake counters. Accessible loading/error/empty/stale states, focus/labels, usable touch targets, and existing routes survive. Fresh local-first onboarding needs no mandatory cloud account. |
| PA-13 | Cancel parent while child/tool runs; restart while approval pending; mutate target/args; deny, expire and revoke permission; exceed depth/concurrency/budget. | No new effect after cancellation/denial. Approval is action/target/args/scope/expiry-bound and single-use; pending state is not approval. Matching owner decisions and cancellation propagate durably with an audit trail. |
| PA-14 | Two fixture tasks use isolated local git workspaces; attach result/test artifacts and a fake PR reference; leave unique local work in one. | Drill-down reaches the correct contract, worker, workspace and evidence. No unapproved merge/deploy or cleanup of unique/uncommitted work. Protected task scope remains enforced. |
| PA-15 | Run versioned EN/TR/DE dialogue, routing, injection and recovery fixtures; later run a separately approved five-project pilot. | Record model/version/hardware, accuracy, latency/resources, escalation/intervention and summary correctness. Offline synthetic success does not select a production model or satisfy the dogfood pilot. |

## What executes now

`test/personal-agent-acceptance.test.js` contains blocking primitive regressions, not a claim that
the app's complete milestone works:

| Test | Existing surface actually exercised | Remaining gap |
| --- | --- | --- |
| PA-R01 | `admitRun` concurrency/idempotency and effect ledger; one fixture effect after duplicate input. | PA-02/11 must prove task/channel dispatch and scoped identity. |
| PA-R02 | A real isolated Node process is killed after fake effect completion, then another process reconciles one artifact/effect and seals its audit. | PA-03 must restart the complete fixture service, including project/child state and notification projection. |
| PA-R03 | An uncertain effect remains `unknown`/awaiting approval through three drives and runs once. | PA-04 must surface it in the parent and supervisor without a notification storm. |
| PA-R04 | Both injected payloads attempt a deterministically denied tool; policy records denial and performs nothing. | PA-07 must also test context assembly, provenance, memory and actual model-tool plumbing. |
| PA-R05 | Explicit approval denial persists across DB close/reopen and prevents the effect. | PA-13 must bind it to a task and test full revoke/cancel/expiry flows. |
| PA-R06 | A fake registered local provider disappears after admission or fails during an attempt; local retries are bounded and cloud spies stay unused. | PA-08 must exercise the real local adapter, streaming loss and app recovery. No real inference is measured here. |
| PA-R07 | Existing desk lease guard refuses a stale heartbeat before the fixture effect; fencing record is unchanged. | PA-09 needs task projection and controlled recovery, not a real browser. |
| PA-R08 | Existing Agent Job initialization reopens twice with integrity and sealed legacy audit intact in the same DB. | PA-10 still needs Lane A's actual additive migration and previous-version rollback; this is not migration acceptance. |
| PA-R09 | A local artifact digest oracle detects modified bytes. | PA-05 needs the product verifier and cited summary, not this oracle alone. |
| PA-R10 | Integrated on-disk entity migration reruns unchanged; flag-off rollback retains legacy approval/audit and task resource links; a separate backup restore is verified. | PA-10 still needs actual previous-binary and whole-home compatibility/restore evidence. |
| PA-R11 | SIGKILL after real entity DDL, before COMMIT; reopen recovers the original schema and records, then migration succeeds. | This is migration crash recovery, not PA-03's full service/child/notification restart. |

`PA-G01` (failed required tool), `PA-G02` (unknown required tool), and `PA-G03` (denied required tool)
are **executed expected failures** in `personal-agent-acceptance-gaps.test.js`. The existing runner
can seal `succeeded` with a model's DONE claim despite these outcomes. Normal regression assertions
first verify failed/denied effects, invocation counts and policy audit. The final named assertion
then rejects treating that run state as certified task success.

This is evidence that the existing runner alone does not implement OP-04/06 task certification,
not a demand to redefine every Agent Job's success: a run may legitimately recover from optional
tool errors. Once Lane A lands the verifier, replace this runner-only mapping with its actual Task
surface and retain the adverse fixture. Do not change runner behavior simply to make a gap test pass.

## CI: known gaps versus regressions

Run the initial suite with:

```sh
npm ci --ignore-scripts --no-audit
npm run test:personal-agent-acceptance
```

The existing `npm run test:ci` discovery includes all four top-level acceptance test files and
assigns them to the regular four shards. No separate CI workflow, retries or product feature flag
is introduced. CI's TAP output records three distinct categories:

1. **PASS**: an existing primitive or harness regression passed. New failures are blocking.
2. **KNOWN_GAP PA-Gxx**: the exact acceptance assertion was reproduced. `expectKnownGap` marks only
   that matching `AssertionError`/case id as an isolated Node TAP TODO child. The parent stays blocking. Setup exceptions, mismatched assertions,
   network attempts and cleanup failures remain blocking. Unexpected pass (`UNEXPECTED_PASS`) also
   blocks until reviewed and promoted; fixes cannot silently leave the gap allowance behind.
3. **TODO PA-xx**: a concrete product integration oracle above is not executable yet. It is not a
   tested failure or a feature pass. Its OP dependencies must be cited until it is enabled.

`personal-agent-acceptance-harness.test.js` runs subprocess probes proving all these distinctions,
including ordinary assertions, wrong-case errors and cleanup failures after a TODO child. It also checks normal CI discovery.

For milestone/release evidence, require **zero known gaps and zero pending cases**, not merely exit 0:

```sh
ORKESTR_PERSONAL_AGENT_ACCEPTANCE_STRICT=1 npm run test:personal-agent-acceptance
```

This test-only switch turns both known failures and unimplemented TODOs into blocking failures.
It is intentionally red on the initial baseline. Do not add a blanket `continue-on-error`, skip
tests based on missing modules, or accept this initial branch as feature-complete. In a mixed failed
CI run, raw TAP `not ok ... # TODO` blocks may appear in the generic failure log; classify by the
TODO marker and process status, not the text `not ok` alone.

Initial local validation: 38 tests including nested reporting cases, **20 pass, 0 fail, 18 TODO**
(three executed known gaps plus 15 pending integration cases). Strict mode exits 1 with 18 failures
and zero TODOs, as required for an unfinished milestone. The existing Agent Job runner, recovery,
approvals, provider and spec suites pass 55/55. These counts are a scaffold baseline, not milestone
acceptance; subsequent CI must report the counts for its own commit.

Integrated foundation follow-up: **40 tests, 22 pass, 0 fail, 18 TODO** (the same three executed
known gaps plus 15 pending integration cases). Strict mode must still exit 1 with 18 failures and
zero TODOs; the two new migration regressions remain blocking in both modes. No known gap was
removed or reclassified merely because its foundation merged.

## Gap ledger by OP item

These statuses report initial acceptance evidence, not current Jira implementation status. See
the integrated follow-up above for OP-02/03/09/18/24 changes at `b479c6d9`. Existing baseline tests
are named where reusable; other lanes' changes require a requested independent PR review.

| OP / tracker | Initial gap and next acceptance evidence |
| --- | --- |
| OP-01 / ORK-535 | Canonical plan/backlog read at `1426c9ae`; implementation/measurement claims still require evidence below. |
| OP-02 / ORK-536 | ADR not in baseline main. Bind all PA cases to Lane A's frozen contract and its flag; no competing schema here. |
| OP-03 / ORK-537 | No durable Project/Task product entities or migration in baseline. PA-01/10 pending; PA-R08 covers existing store only. |
| OP-04 / ORK-538 | Task lifecycle, bounded contract and verified terminal result absent. PA-G01..03 reproduce the runner-only evidence gap; PA-02/05/13 pending. |
| OP-05 / ORK-539 | Effect/checkpoint primitives exist (PA-R01..03); correlated project/task cursor feed and replay still PA-03/11. |
| OP-06 / ORK-540 | No project/task evidence-backed status projection. PA-G01..03 plus PA-01/04/05; PA-R09 is only the artifact oracle. |
| OP-07 / ORK-541 | No product provenance-carrying memory/context boundary. PA-01/07 pending; PA-R04 proves policy denial only. |
| OP-08 / ORK-542 | Main local conversational assistant not integrated. PA-01/05/06 pending, including ordinary chat without project creation. |
| OP-09 / ORK-543 | Baseline has no registered local adapter. PA-R06 uses a fake registry adapter; PA-06/08 and real local-only measurement remain. |
| OP-10 / ORK-544 | No task-bound escalation/privacy/budget contract exercised. PA-08 pending; PA-R06 protects no implicit fallback in the fixture run. |
| OP-11 / ORK-545 | No real-model evaluation evidence. PA-15 defines the report and separates deterministic fixtures from model quality. |
| OP-12 / ORK-546 | Existing workers/task agents are not yet bound to the new task contract. PA-02/03/13; PA-R01/02 are runtime foundations only. |
| OP-13 / ORK-547 | No task supervisor/parent stall projection. PA-04 pending; PA-R03 protects uncertain effects from automatic retry. |
| OP-14 / ORK-548 | Existing policy/approvals exercised by PA-R04/05; task scope, instruction origin and cancellation need PA-02/07/13. |
| OP-15 / ORK-549 | No task-to-workspace handoff acceptance. PA-14; reuse existing worker worktrees and release rules. |
| OP-16 / ORK-550 | Stale lease guard passes PA-R07; task blocker/recovery and desk evidence still PA-09/14. Root isolation is not an acceptance claim. |
| OP-17 / ORK-551 | No shared assistant identity/cursor/task continuation across channels. PA-11; use fake senders/echo fixtures only. |
| OP-18 / ORK-552 | Flagged main-assistant home absent in baseline. PA-06/08/12 need app/API and accessibility evidence, no fabricated counters. |
| OP-19 / ORK-553 | No task-detail evidence drill-down. PA-14, including permission-safe links to existing worker/desk resources. |
| OP-20 / ORK-554 | No unified task approval/memory/settings inbox. PA-07/09/13; denial durability is already PA-R05. |
| OP-21 / ORK-555 | Personal-agent first useful task not integrated. PA-12 and an isolated fresh-install walkthrough/time measurement. |
| OP-22 / ORK-556 | Initial plan, guarded expected failures, offline regressions and reporting probes delivered here. Full milestone remains gated on PA-01..15. |
| OP-23 / ORK-557 | Five-project pilot not run or authorized by this suite. PA-15 defines evidence; no dogfood/public-quality claims from fixture success. |
| OP-24 / ORK-558 | Product migration/release rollback untested until OP-03/21 land. PA-10/12, strict suite and existing release train required. |

## Integration sequence and rollback notes

1. Freeze OP-02 with Lane A; review its migration/event contract independently. Replace contract-pending
   TODOs only after the actual symbols/routes exist, with the precise prerequisite PR/commit noted.
2. Enable PA-01/02/05/10/11/13 as Lane A's entities, events, lifecycle, permissions and projections land.
   Preserve the executed adverse fixtures; certify artifacts rather than model completion prose.
3. Integrate Lane B's local adapter/context (PA-07/08), then PA-06 against Lane C's app home. Use a
   disposable service for PA-03/04 and injected deadlines for deterministic restart/stall evidence.
4. Enable remaining workspace/desk/channel/UI cases, request independent PR review, and publish the
   strict result with counts and artifacts. Only the coordinator can advance program/release status.

This PR changes tests, fixtures, documentation and a test command only. It adds no production schema,
event type, migration, route, service, scheduler or runtime setting. Rollback is a normal revert of
these files/script entry; existing application data needs no rollback. Tests close their fixture DBs
and remove only their own validated temporary homes. Product migration rollback must later follow
PA-10 on copies/backups; do not drop new task tables or delete unique worker data as a downgrade.
