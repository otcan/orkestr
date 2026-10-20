# V2 parity inventory, revision 1

This is the V2-001 source-audit baseline, not a passing parity report or a
production migration. Inspected on 2026-10-18 at branch commit
`fffa3d8cb4d0924c297ee771da9c1c3a8d9b5a2c`. The inventory belongs to the
separate `v2/rust-rewrite` track; it does not reassign the active 1.x personal-agent
workers or create another backlog. V2-002 and V2-050 consume it incrementally.
Upstream planning advanced to `a7ba6d59` during this audit; the source observations
below remain pinned to the stated baseline. The internal metadata-only journal
contract is an incremental subset, not the full authenticated M1 event/API model.

## Evidence boundaries

- **Observed source** means a concrete implementation or test definition was
  read at this commit. Tests listed below were **not executed by this audit**.
  Their presence does not prove deployment, correctness or current test status.
- **Specified** means a v2 requirement in [README.md](README.md),
  [workstreams.md](workstreams.md), or [migration.md](migration.md). An intentional
  behavior change is identified rather than attributed to an existing product.
- The installed release symlink was inspected read-only and identified release
  marker `main-b90a23ab8739`. This is not proof of the loaded server process,
  connector versions or feature flags. The git tag `v0.1.0-alpha.211` points to
  `fb0cbfce5138bf03f6a85af70692bbcdf39d1ee8`; neither replaces this audit's pinned
  branch baseline. A later snapshot export must record its own source versions.
- No live data home, user histories, database, credentials, browser profile or
  session was opened. No provider, routing, service, timer or deployment was
  changed. This is deliberately not an assertion about personal installations.
- Decisions below preserve outcomes and historical evidence. **Replace** means
  implement in v2; **retain external** means a separately connected service;
  **defer** means explicit missing capability, not silently drop imported records.

## Runtime and data ledger

| Capability / source evidence | Observed source and v2 decision | Golden parity case to implement |
|---|---|---|
| Thread identity and registry: `packages/storage/src/thread-registry.js`; `packages/storage/src/public-references.js` | JSON fallback and SQLite records coexist; public references are immutable and replacement writes check revisions/removals. Read-time deduplication uses owner/name before ID. **Replace** with canonical typed IDs and explicit import mappings; never apply the legacy name heuristic to collapse snapshot records silently. | Import two same-name source threads with distinct IDs, a public reference and a stale revision. Preserve both source identities or quarantine a collision; never silently erase one. |
| Messages and history: `packages/storage/src/thread-message-schema.js`; `packages/storage/src/thread-message-page-store.js`; `apps/server/src/modules/threads/thread-messages.controller.ts` | Message rows preserve per-thread position/cursor, source, phase, parent, client/external IDs and provider item/turn IDs. History reads may schedule native-history sync in 1.x. **Replace** with side-effect-free imported history and explicit optional provider sync. | `test/thread-message-store-page.test.js`: paged/full history equivalence, old pending questions, revision invalidation. Import exact positions/timestamps and reconnect from cursor without omitting commentary or duplicating final output. |
| General event log: `packages/storage/src/store.js` | JSONL rotates and archives are pruned; oversized payloads become `event_payload_truncated`. Atomic JSON rename is separate from log append. **Replace** with transactional v2 metadata journal. Legacy JSONL is supporting evidence, not a complete replay authority. | Truncated, missing and malformed legacy events cannot reconstruct missing messages or mark tasks done. Preserve diagnostics and report gaps while importing canonical stores. |
| Job persistence: `packages/core/src/agent-job-store.js`; `packages/core/src/agent-job-runner.js` | SQLite holds specs, runs, attempts, checkpoints, effects, approvals, notifications and schedule state. Runs retain pinned specs, leases and retry state. **Replace**, preserving independent run/task identities. | `test/agent-job-runner.test.js`: admitted-before-start crash, concurrent duplicate admission, bounded recovery attempts and disconnected-provider refusal. SIGKILL/reopen must not invent a live executor. |
| Personal-agent tasks: `packages/core/src/personal-agent-tasks.js`; `packages/core/src/personal-agent-feature.js` | Feature-gated tasks have explicit contracts, dependencies, budgets, transition evidence and criterion-based completion. The inspected transition function itself does not require supervisor admission to enter `running`. **Replace** while retaining stronger v2 admission evidence; do not mistake a state string for an executing worker. | `test/personal-agent-tasks.test.js`: request-key conflicts, terminal immutability, invalid criteria, worker-only completion refusal. Add admission/lease/fence checks before running and stale-completion refusal. |
| Task acceptance gap: `test/personal-agent-acceptance-gaps.test.js` | Tests explicitly distinguish runner success from task certification, including failed/unknown/denied required tool results. Some acceptance oracles remain TODO unless strict mode is enabled. **Replace** with independent criterion verification, retaining every known regression as an explicit target. | A model's “done” text and a successful run cannot certify a failed required artifact. Do not count TODO or known-gap tests as passing v2 acceptance. |
| Effects and approvals: `packages/core/src/agent-job-effects.js`; `packages/core/src/agent-job-store.js` | Effect identity and argument hash, dispatch timestamp, reconciliation, approval and unknown outcomes are distinct. **Replace** with exact-scope approvals and quarantine. No general exactly-once network promise. | `test/agent-job-approvals.test.js` and `test/agent-job-runner.test.js`: changed arguments, expiry, concurrent consumption, crash before/after dispatch, reconcile once, unknown without blind retry. |
| Runtime sessions and workers: `packages/core/src/runtime-codex-adapter.js`; `packages/core/src/runtime-leases.js`; `packages/core/src/runtime-liveness.js`; `packages/core/src/thread-workers.js` | Provider-session identity, orchestration thread identity, runtime leases, checkpoints and worker relationships are separate source concepts. **Replace** orchestration; **retain external** supported Codex/Claude processes. Persistent fast/deep session separation is a v2 requirement, not demonstrated by this inventory. | Fake adapter admits a second input while one turn is busy; one native session has one active turn; expired worker cannot publish completion. Preserve source worker lineage even when no provider is connected. |
| Timers: `packages/core/src/timers.js`; `packages/core/src/timer-run-guard.js` | Enablement, next run, failure backoff and deduplication are explicit. Some missed daily fires coalesce. **Replace**, import every timer dormant with original enablement recorded separately. Resuming imported schedules is an explicit later action: per-thread import, fence-first single-owner handoff/handback, zoned DST schedules, Deep-turn execution and WhatsApp relay are in [thread-timers.md](thread-timers.md). | `test/timer-loop-reliability.test.js`: overlapping ticks, repeated/skipped DST hours, many missed runs, backoff recovery. Paused/cancelled timers remain inactive; import generates no catch-up run. |
| Connector outbox: `packages/connectors/src/connector-outbox.js`; `packages/connectors/src/connector-outbox-retry-policy.js` | Delivery has a durable ledger and retry policy; terminal archived work cannot be claimed. **Replace** behind the effect boundary, retain accepted/uncertain/cancelled evidence. | `test/connector-outbox-retry-policy.test.js` and `test/whatsapp-connector-outbox.test.js`: payload/key conflict, accepted receipt, stale archive, unknown outcome. Projection replay and importer never drain a queue. |
| WhatsApp attribution and routing: `packages/core/src/thread-bridge-messaging.js`; `packages/connectors/src/whatsapp-thread-groups.js`; `packages/connectors/src/whatsapp-owner-selfchat-runtime.js` | Multiple paths exist; thread/account bindings and origin/parent-message delivery policy matter independently of visible text. **Replace** optional adapter; preserve historical bindings as disabled records until an approved handoff. | `test/thread-bridge-whatsapp-rollout-authority.test.js`: opt-out survives completion, ambiguous parent fails closed, replacement-account destination is not inherited. Add own-echo, duplicate provider ID and uncertain send cases. All synthetic; no channel activation. |
| Memory: `packages/core/src/personal-agent-memory-service.js`; `packages/core/src/personal-agent-memory-sqlite.js`; `packages/core/src/personal-agent-memory-rules.js` | Dedicated consent/provenance/rule/storage code exists independently of message history. **Replace** with deletion-aware scoped memory. An imported conversation or successful task is not a new consent grant. | `test/personal-agent-memory-service.test.js`, `test/personal-agent-memory-rules.test.js`: consent, scope and correction/forget checks. Rebuild cannot resurrect removed payloads from journal metadata. |

## API, UI and integration ledger

| Surface / source evidence | Observed source and v2 decision | Golden parity case to implement |
|---|---|---|
| Thread HTTP API: `apps/server/src/modules/threads/threads.controller.ts`; `thread-messages.controller.ts`; `thread-runtime.controller.ts`; `thread-binding.controller.ts` in the same directory | 1.x exposes thread CRUD, history/uploads, runtime and binding operations in separate controllers. **Replace** with versioned contracts; migration need not reproduce URL names, but must map every retained operation. | Authenticated accept returns stable identity before inference; cross-owner history/upload/binding denied; repeated request returns original result or body conflict. Endpoint-level parity remains pending. |
| Streaming: `apps/server/src/thread-stream.ts`; `apps/server/src/thread-stream-summary.js`; `apps/web/src/app/thread-message-list.component.ts` | Server stream and message projections are distinct from provider streams. **Replace** with bounded cursor SSE and typed client reducers. | Disconnect during progress, reconnect, then final; no repeated item or lost draft; slow subscriber cannot block durable acceptance. Token buffering is not task completion. |
| Composer, attachments and ordinary navigation: `apps/web/src/app/thread-composer.component.ts`; `thread-composer.component.html`; `thread-message-list.component.html` in the same directory | Draft emits independently; send readiness includes upload readiness; textarea uses input readiness. **Replace** Angular rendering while retaining accessible input, preview and message behaviors. | `test/draft-upload-browser.test.js`, `test/draft-attachments.test.js`, `test/mobile-attachment-ux.test.js`: unfinished upload, retry, cancel and retained draft. Add measured IME, keyboard, screen reader and mobile reconnect cases in Dioxus. |
| Personal-agent Home: `apps/web/src/app/personal-agent-home.component.html`; `apps/server/src/modules/personal-agent/personal-agent.controller.ts` | Existing Home renders primary conversation, capability/unavailable state and work/attention/result sections. Controller shown exposes capability; rendering sections is not evidence of a complete execution projection. **Replace** with v2 Assistant/Projects/Attention/History and one default conversation per scope. | `test/personal-agent-home-ui.test.js`: unavailable/stale state must remain truthful. A project opens without GitHub/Jira/WhatsApp; worker details do not become mandatory top-level chats. |
| Authentication and access: `packages/core/src/principal.js`; `packages/core/src/auth-config.js`; `packages/core/src/thread-resource-grants.js`; `apps/server/src/modules/system/owner-login.controller.ts` | Principal, login and thread grants exist separately. **Replace** first-admin/session/scope enforcement; no legacy authentication cookie or grant becomes ambient v2 authority. | `test/auth-config.test.js`, `test/thread-resource-policy-operations.test.js`: deny missing owner/scope, revoked grant and cross-project worker. Every API operation needs authorization, not just UI hiding. |
| Vault and secret links: `packages/core/src/vault-store.js`; `packages/core/src/secret-links.js`; `packages/core/src/secure-secrets.js` | Credentials are separate from ordinary messages, with dedicated sharing/approval flows. **Replace** orchestration surfaces; **defer** any automatic credential portability. | `test/secret-links.test.js`, `test/secure-secrets.test.js`: one-time/expiry and redaction. Import rejects secret payloads and resolves missing handles as unavailable, never scans the live home to fill them. |
| Desktop/browser resources: `packages/browsers/src/desktop-lease-store.js`; `packages/browsers/src/desktop-capability-broker.js`; `apps/server/src/modules/browsers/browsers.controller.ts` | File-locked leases include thread/owner identity and fencing version/token. **Retain external** managed browser/desktop, **replace** lease broker and UI. A copied worktree/profile is not containment. | Conflicting thread acquisition denied, stale fence rejected, heartbeat/release match owner; imported lease dormant. No browser launch or inherited cookies during preview. |
| Git/workspace and worker ownership: `packages/core/src/worker-git-ownership.js`; `packages/core/src/worker-branch-push.js`; `packages/core/src/thread-workers.js` | Local Git ownership/worktrees and worker-parent associations require explicit handling. **Retain external** Git, **replace** project resource service. | `test/worker-git-ownership.test.js`, `test/worker-branch-push.test.js`: never reset another worktree or push using a different owner. Import absolute paths as unavailable references pending deliberate rebinding. |
| Optional Gmail and specialist integrations: `apps/server/src/modules/connectors/connectors.controller.ts`; `apps/server/src/modules/connectors/google-workspace-review.controller.ts`; `apps/server/src/modules/mailboxes/mailboxes.controller.ts` | Optional connector and mailbox APIs exist. **Retain external** providers; **replace** capability adapters after individual inventories. Gmail/LinkedIn/browser workflows remain parity obligations, not core-start prerequisites. | Absent connector does not block first local project; expired auth does not fall back to another identity. No OAuth/browser state imported. Detailed read/write scopes and workflow fixtures remain unverified here. |
| Native/mobile/voice and managed surfaces: `apps/server/src/modules/mobile/mobile.controller.ts`; `mobile-voice/mobile-voice.controller.ts`; `mobile-realtime/mobile-realtime.controller.ts`; `tenant-slices/tenant-slices.controller.ts` under `apps/server/src/modules` | These are implemented 1.x surfaces, not evidence that Dioxus/iOS or tenant provisioning exists in v2. **Defer** voice and managed provisioning until explicit parity decisions; **replace** mobile conversation client via measured Dioxus gate. | Import historical references without provisioning VMs/calls. Native simulator, background reconnect and on-device acceptance must be measured independently of web tests. |
| Installation/release boundaries: `packages/core/src/setup.js`; `packages/core/src/user-onboarding.js`; `docs/release-train.md` | Existing installation and release machinery is separate from an isolated v2 workspace. **Replace** v2 local packaging; retain 1.x deployment untouched. | `test/first-run-onboarding.test.js` as reference: separate home/port/environment/cookie namespace; no optional account required for offline fixture. V2 CI cannot deploy, migrate or modify 1.x services. |

## Copy-only import requirements derived from actual stores

`packages/storage/src/paths.js` lists several independently persisted authorities;
`packages/core/src/agent-job-store.js` defines an additional job database. A single
JSON export or a replay of the general event log is insufficient. V2-050 needs an
explicit snapshot manifest that inventories these categories without opening them
in this audit:

1. **Registry and history:** `threads.json`/`threads.sqlite`, per-thread legacy
   message files and `thread-messages.sqlite`, raw message provenance and uploads.
   Identify authoritative format and consistency point; preserve non-selected
   copies as evidence and report divergence. Source IDs, public refs, position,
   source timestamp strings and relationship references must survive.
2. **Execution:** job specs/runs/attempts/checkpoints/effects/approvals,
   personal-agent project/task/transition/memory tables, runtime lease metadata,
   timer definitions and enabled states. Import historical state, never active
   leases, runnable jobs, live approvals or due triggers.
3. **Delivery:** connector outbox and relevant bridge journals/receipt records.
   Keep accepted, unknown, cancelled, suppressed and pending distinct. No
   inferred success from a generated assistant message. Provider ownership
   changes require a separately reviewed cutover, not import completion.
4. **Resources:** artifact manifest with content hashes and safe relative paths;
   Git/workspace and desktop metadata as unavailable references. Missing files,
   path traversal, external symlinks and cross-owner links must be quarantined.
5. **Exclusions:** secrets, OAuth state, browser profiles, provider authentication,
   private keys and cookies. Do not use legacy path defaults or environment
   fallbacks to locate excluded material. The caller supplies an explicit copied
   snapshot root, and v2 uses its own empty data home.

Consistent SQLite snapshots must include committed WAL data through a supported
backup/export process, not an arbitrary copy of only the main database file.
Cross-file consistency needs a manifest/checkpoint; it is not implied by each
file's atomic rename. Preserve original snapshot hashes and count discrepancies.
Idempotent import keys bind snapshot/source/entity identity; re-import cannot
create another task or deliver an external effect.

## Immediate first-slice implications and open evidence

- Journal append plus projection update must be one SQLite transaction. A retry
  with identical request key/body returns the prior receipt; changed body fails.
  Rebuild validates sequence and event version, fails on unsupported events,
  and executes no adapters. Crash/reopen and idempotency require real tests.
- Graph and task projections retain distinct scope IDs, parent/fork/dependency
  edges and original import references. Reject missing/cyclic links; do not
  fabricate a parent from a display name. Runtime sessions are not graph IDs.
- The v2 requirement for supervisor-backed running state is stronger than the
  inspected 1.x task transition function. Preserve historical status as source
  evidence, but do not grant current runtime authority to imported `running`.
- No audited row above is marked v2-complete. The in-memory scaffold at the
  baseline is not a durable journal, server, auth boundary, UI or importer.
- Endpoint coverage, actual configured legacy store modes, loaded release and
  feature flags, consistent snapshot schema versions, active optional workflows,
  local OXRM API, native iOS feasibility and real-provider subscription behavior
  remain unverified. Later owner-approved snapshot/local testing must close these
  gaps without accessing live credentials or duplicating external actions.
- Important 1.x fixes after the pinned baseline need small, reviewed additions to
  this ledger. Do not merge ongoing feature work wholesale or claim an old test
  name proves the new requirement. Coordinator owns the versioned contracts and
  database integration; this document intentionally creates no parallel schema.
