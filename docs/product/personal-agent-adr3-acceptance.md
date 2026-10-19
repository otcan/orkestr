# ADR 0003 acceptance additions — OP-22 / ORK-556

This is an executable **pending-integration inventory**, not a feature-complete
milestone or evidence that any provider session exists. Source: ADR 0003,
`docs/personal-agent-opinionated-architecture-20261018` at `3a5c8c37`, sections
2–5, 9 and 10 (PR #65). That document is not yet on this branch's base;
do not silently substitute ADR 0002's earlier local-first product direction.

Base: `88406e7b`. No product schema, migration, event envelope, controller,
runtime setting, channel binding or password-handoff behavior changes here.

## Authority and scope

ADR 0003 supersedes the older plan wherever it requires actual, distinct,
persistent subscription-backed Codex/Claude Code fast and deep sessions, global
and project main conversations, automatic project resources, progressive
onboarding and iOS-first navigation. The optional local adapter is not the
reasoning authority or an implicit fallback. In particular, older PA-06/PA-08
local-model integration requirements cannot be used as the new main-assistant
acceptance gate. Their local-adapter primitive regressions remain useful.

Owner clarification (2026-10-18): every actual new project, including a shopping
list, defaults to all four resources: GitHub repo, Jira project, OXRM workspace
and project WhatsApp conversation. Provision idempotently or expose an exact
blocker; lazy provisioning is not the default. Project creation instantiates
zero desktops; desktop leases are acquired only on later demand. Plugins have
five distinct layers from the outset: package, multiple account connections,
capabilities, global/selected-project bindings and resource instances. Global
defaults are inherited and projects can narrow them, never escalate them.

Preserve ADR 0002 storage/lifecycle, opt-in memory, Agent Job effects/approvals,
existing security and `ORKESTR_PERSONAL_AGENT_ENABLED` (default off). Existing
PA-R/PA-G tests are foundations, not substitutes for the AT cases. Lane-owned
APIs and schema remain authoritative; this inventory defines no competing
product interface or new task database.

## Code and fixture boundary

- `test/fixtures/personal-agent-acceptance/adr3-cases.mjs` records all 15 cases
  (AT-01–12 plus AT-07a/b/c), scenario, three concrete assertions, owning lanes,
  OP dependencies, present gap, and reusable foundation cases.
- `test/personal-agent-adr3-acceptance.test.js` registers explicit TODOs with
  `PENDING_ACCEPTANCE` assertions, deliberately failing without TODO in strict
  mode. These assertions report missing integration, **not** reproduced product
  failures. No fake application implementation can satisfy them.
- `test/personal-agent-adr3-acceptance-harness.test.js` is blocking: it validates
  coverage and scenario/oracle metadata, tests normal/strict reporting in
  stripped-environment Node children, and checks regular CI discovery. It does
  not test product behavior.

Only synthetic IDs, text and paths belong in these files. The pending tests
perform no I/O to a product instance and invoke no provider, browser, messaging
transport, service manager or cloud API. Harness subprocesses run only the
pending Node test file, without inherited home, credentials, overlay or endpoints.

When an integration is promoted, use the existing `offlineFixture` network-denial
guards and temporary home or equally strict lane fixtures. Only Node fixture
children may be killed/restarted. Simulated external effects record local fixture
receipts; never send real messages or create a real repo, Jira project, OXRM
workspace or WhatsApp conversation. No paid model calls, downloads, deployment,
real credentials or production scheduler/lease changes are part of this suite.

## Gap ledger and required evidence

The executable inventory contains the complete assertions. This table names the
first supported integration needed, not new APIs the lanes must implement.
OP dependencies retain the applicable original plan references and add the
ADR 0003 implementation owners OP-25–OP-32 (ORK-561–ORK-568). They are dependencies,
not claims that those items or their acceptance integrations are complete. The
blocking harness checks that this ledger and the executable inventory agree.

| Case | OP dependencies | Pending integration / owner | Required adverse evidence |
| --- | --- | --- | --- |
| AT-01 | OP-05 OP-17 OP-22 OP-25 | Lane 1 ingress + Lane 3 runtime + Lane 4 UI: ordered dual inbox and deterministic receipt | Both model latches held, concurrent/duplicate inputs accepted durably before release; changed key conflict, exact parent correlation, separate receipt/fast/deep timing |
| AT-02 | OP-08 OP-12 OP-22 OP-26 | Lane 3 capable reasoning dispatch independent of fast session | Fast busy/down cannot drop reasoning; deep unavailable/quota/auth loss is blocked, with no silent API/local/cloud substitution |
| AT-03 | OP-08 OP-12 OP-22 OP-26 | Lane 3 distinct native fast/deep/execution sessions | Model/native-session changes keep canonical transcript; fixture IDs do not prove real subscription authentication |
| AT-04 | OP-06 OP-12 OP-14 OP-22 OP-27 OP-31 | Lanes 1/3 global fan-out/fan-in and project scope | Three projects, one blocked, reversed completion, fourth unauthorized; partial answer, no cross-project reads or blocked owner input |
| AT-05 | OP-05 OP-12 OP-14 OP-22 OP-25 | Lanes 1/3 task-bound correction and effects | Correction/duplicate/restart before dispatch, obsolete approval refused, uncertain effect reconciled or held; no duplicate sends |
| AT-06 | OP-13 OP-14 OP-20 OP-22 OP-32 | Lanes 1/3 deterministic durable hold + Lane 4 truthful status | Closed model latches; stop before/during/after dispatch, repeated after restart; no new effect, truthful too-late/unknown status |
| AT-07 | OP-03 OP-14 OP-16 OP-22 OP-27 | Lanes 1/3 canonical bindings and scoped leases | Fast/deep/workers reuse A's binding; B denied, stale heartbeat/fencing denied before effect, scoped concurrency quotas |
| AT-07a | OP-03 OP-21 OP-22 OP-27 OP-30 | Lane 1 project provisioning + Lane 4 contextual auth/status | Shopping-list and software projects both automatically provision all four default fake resources, zero desktops; exact blockers, partial failure/retry/restart never duplicates or fabricates readiness |
| AT-07b | OP-14 OP-20 OP-22 OP-30 | Lane 1 inheritance/policy + Lane 4 connection selection | All five plugin layers, multiple account identities, global/selected/disabled projects; inherited defaults can only narrow, revocation applies to pending work |
| AT-07c | OP-18 OP-21 OP-22 OP-30 | Lane 4 progressive entry/auth + Lane 1 health | Assistant before all optional connections; callback returns to same context; partial provisioning and missing provider truthful, tenant/admin boundaries intact |
| AT-08 | OP-12 OP-15 OP-19 OP-22 | Lane 3 reuse/fork/fresh lineage | Pinned snapshot/parent, explicit fresh brief and rationale, expiry/reopen history; unsupported native fork never silently fabricated |
| AT-09 | OP-05 OP-12 OP-13 OP-22 OP-25 OP-26 | Lanes 1/3 whole-service reconciliation | Kill/restart at four boundaries; ordering/holds/approvals/leases/lineage survive, one effect/result; injected stall yields one evidenced blocker with bounded retries |
| AT-10 | OP-04 OP-06 OP-07 OP-14 OP-22 | Lanes 1/3 task verifier/control + Lane 4 owner surfaces | Worker/web injection cannot certify/approve/consent; failed/unknown/denied/changed evidence cannot produce task success; valid artifact cited |
| AT-11 | OP-18 OP-19 OP-20 OP-22 OP-28 | Lane 4 native iOS navigation and security fixture | Global/project/task/run/resource/approval/back, reconnect and project switch retain context; no cache/notification leaks; web DOM is not native evidence |
| AT-12 | OP-02 OP-17 OP-24 OP-22 | All lanes: flag-off differential app/channel fixture | Unset/0/false and on→off preserve legacy behavior/data/routes/senders/timers/auth/blindness; no provider launch, implicit deploy or new external effect |

For AT-01, hold model completion behind explicit deferred promises; accept and
persist inputs before releasing them. Use a bounded test timeout as a deadlock
guard, not hardware-dependent latency assertions. Record acceptance/visible
receipt, fast response, deep response and execution separately. Later measure
p50/p95 against real subscription runtimes and hardware with separate owner
authorization. A deterministic receipt is not a finished answer.

AT-05/06 must test dispatch boundaries, not merely assert that a cancellation
message was sent to a model. AT-09 must reopen the same disposable durable home,
not recreate an in-memory fake and label it restart recovery. An approved effect
that has already been dispatched may be irreversible; expose too-late/unknown
rather than falsely reporting it stopped.

## Known gaps versus regressions in CI

Run the additions:

```sh
npm run test:personal-agent-adr3-acceptance
```

They are also appended to `npm run test:personal-agent-acceptance`, and both
top-level files participate in existing four-shard `test:ci` discovery. No new
workflow, blanket catch, retry, skip-on-import-error or continue-on-error is used.

- **PASS:** blocking inventory/harness checks or promoted product regressions.
  Harness passes are never counted as satisfied AT product cases.
- **TODO / PENDING_ACCEPTANCE AT-xx:** a named integration is not implemented.
  Its TODO assertion does not claim to have reproduced a product defect.
- **KNOWN_GAP:** only an actual adverse product probe may use the existing
  `expectKnownGap` reporter, which accepts just its exact assertion/case ID.
  Setup errors, network attempts, wrong assertions and cleanup stay red; an
  unexpected pass forces review and promotion. Existing reporter self-tests
  remain required. None of the new AT cases is mislabeled KNOWN_GAP.
- **FAIL:** any blocking regression, inventory/import error, harness reporting
  mismatch, or a still-pending AT case under strict mode.

Strict milestone gate (intentionally red until implementation):

```sh
ORKESTR_PERSONAL_AGENT_ACCEPTANCE_STRICT=1 npm run test:personal-agent-adr3-acceptance
```

The initial additions must report **4 pass / 0 fail / 15 TODO** normally and
**4 pass / 15 fail / 0 TODO** in strict mode. An exit-zero development CI with
TODOs is not end-to-end acceptance or authorization to release. Existing PA
TODOs/known failures remain independently visible; this PR does not reclassify
them or treat local-adapter availability as ADR 0003 completion.

## Promotion, review and rollout

1. Request the owning lane's exact-head PR and supported fixture entry points.
   Review independently before wiring acceptance to its actual APIs. Do not
   cherry-pick or alter another lane's schema/controller to make a test pass.
2. Replace one pending registration with actual product integration, keeping
   positive, denial, concurrency and restart variants above. Update inventory,
   TODO counts and reporting checks explicitly; a fixture-only runtime cannot
   certify native authentication, quality, latency or iOS behavior.
3. Record exact commit, tests, real-vs-synthetic evidence and remaining gaps.
   Require zero pending ATs/known gaps for the milestone, plus separately approved
   supported subscription-session and native navigation evidence. Independent
   reviewers, not this test author, review this acceptance PR.
4. Coordinator owns integration/release/Jira. This work does not merge/deploy,
   touch open implementation PRs or live settings, change channels, or imply
   application controls isolate root-capable runtimes. Root/raw-runtime bypass
   remains outside the single-user application trust boundary.

Rollback is a normal revert of these test/fixture/docs/script changes. There is
no product migration, new database, live state or data rollback to perform.
