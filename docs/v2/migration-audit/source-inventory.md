# Read-only inventory adapter audit

Source inspected at original audit baseline
`76f9c6cd91e094329ae5c29c7e95f301366ed02a`. This table begins the inventory of
workflow **kinds**; it does not claim that every kind exists or is used in any
installation. No live identifiers/results are stored in this public repository.
No live API, DB, secret, profile or connector was read for this increment.

| Kind / source API | Source symbols | Inventory limitation |
|---|---|---|
| Threads, workers, messages | `apps/server/src/modules/threads/threads.controller.ts::list/summary`; `apps/server/src/thread-summary.ts::threadSummaryPayload`; `packages/core/src/thread-workers.js::listThreadWorkers` | Summary reads per-thread history and resolves native runtime metadata. Message GET/history can schedule/force native sync. Do not use them as inert inventory/export. Need count-only registry projection with no history/profile access. |
| Timers + scheduled agent jobs | `apps/server/src/modules/timers/timers.controller.ts::list`; `packages/core/src/agent-job-timer-entries.js::listAgentJobScheduleTimers`; `packages/core/src/agent-job-store.js::openAgentJobDb` | Schedule listing opens job DB with schema initialization and WAL PRAGMAs. It is not guaranteed physically read-only. Need preexisting-store count projection without initializer. |
| Connector prompt pushes / automations | `apps/server/src/modules/automations/automations.controller.ts::list`; `packages/core/src/automations.js::listAutomationsForPrincipal` | Aggregates timers and connector prompt pushes; source definitions/payloads are private and not a coherent snapshot. Need kind counts and explicit exclusions, not prompts/targets. |
| Job triggers/hooks/runs/effects/approvals/results | `apps/server/src/modules/jobs/agent-jobs.controller.ts::trigger/hook`; `packages/core/src/agent-job-store.js::schema/rowToRun/rowToAttempt` | Trigger/hook POSTs dispatch work and must never be inventory calls. No consistent all-authority export/count contract established. |
| Personal-agent projects/tasks/dependencies/completion | `apps/server/src/modules/personal-agent/personal-agent.controller.ts::capability`; `packages/core/src/personal-agent-tasks.js::taskFromRow` | Capability metadata does not enumerate historical tasks or establish feature usage. Need feature-aware counts with absent-store distinctions, not initializer side effects. |
| Resources/grants/mailbox listeners/routes | `packages/core/src/thread-resource-policy-store.js` tables `orkestr_thread_resources`, `orkestr_thread_resource_grants`, `orkestr_mailbox_routes` | Metadata and authority must be separate. No credentials, live sessions, delivery routes/targets or grants may become executable import state. |
| Browser/desktop references | `apps/server/src/modules/browsers/browsers.controller.ts::browsers/browserSessions/desktopLeases` | Managed lease APIs are appropriate for active use, not permission to copy profiles or leases. Need unavailable-reference counts only for migration. No desktop acquired. |
| Installed setups/workflow bundles | `apps/server/src/modules/setups/setups.controller.ts::list/status/export` | Manifest catalog is not installed/used-workflow census; status/export have separate implementation/authorization semantics. Do not assume export is a complete history snapshot. |
| Connector identities/status, outbound receipts | `apps/server/src/modules/connectors/connectors.controller.ts`; `packages/connectors/src/connector-outbox.js` | Status APIs do not export coherent history; no relink, start, repair, send or route action is an inventory operation. Need enabled-kind counts and redacted effect/receipt export. |
| Artifacts, Git/workspace references, memory/tombstones | `packages/core/src/thread-sandbox-artifacts.js`; `packages/core/src/personal-agent-memory-sqlite.js`; `docs/v2/parity-inventory.md` | Preserve snapshot hashes and unavailable references. Consent, tombstones, retention and external-resource completeness require explicit Core export policy. |

Precise dependency: Core/coordinator must expose or identify an authenticated,
side-effect-free kind-count inventory projection that returns coverage/exclusions,
source version and consistency watermark. Avoid message/native provider reads,
store initialization and outbound calls. Private per-instance results must remain
in a private operator overlay, never these fixtures. Existing GET routes are not
assumed safe merely from their HTTP method. This audit does not label unknown
usage as zero or complete. Full-release acceptance remains blocked on that census
and review of every currently used kind; iOS is deferred by the release scope.
