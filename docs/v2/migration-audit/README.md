# Copy-only migration field audit

Source/contract baseline: `76f9c6cd91e094329ae5c29c7e95f301366ed02a`.
This adds field-level evidence and executable synthetic checks to
[the parity inventory](../parity-inventory.md), not a second inventory, schema,
store, exporter or importer. Read with [migration requirements](../migration.md)
and V2-050 in [workstreams](../workstreams.md).

No live data was inspected. Fixtures are deliberately incomplete synthetic
source excerpts plus audit expectations, **not v2 API payloads**. Audit keys such
as `disposition` and `target_contract` have no product contract status.

## Actual source to actual target

Paths below are repository-relative; symbols/table names are searchable anchors.
A target name indicates representational overlap, never import authorization.

| Source path / symbol and fields | Existing target / overlap | Required disposition or gap |
|---|---|---|
| `packages/storage/src/thread-registry.js`: `listThreadRecords`, `findThreadRecordByPublicRef`, `orkestr_threads.data`; `id`, `publicRef` | `v2/crates/contracts/src/lib.rs`: UUID `ConversationId`, `ProjectId`; `Project.name` | Preserve source ID/publicRef in private provenance; explicit stable mapping needed. No publicRef or import provenance field exists. Never merge same-name records through legacy `dedupeThreadRecords`. Root thread is not automatically a project. |
| `packages/core/src/thread-workers.js`: `createThreadWorkerScoped`, `rootThreadId`; `parentThreadId`, `rootThreadId`, `threadKind`, `ownerUserId`, `baseBranch`, `baseCommit`, `repoPath`, `worktreePath` | `v2/crates/orkestr-domain/src/lib.rs`: `ConversationCreated {id,kind,parent_id}`, `ConversationKind::Worker` | Only parent edge/kind overlap in metadata journal. HTTP intake conversations have no parent/root fields and one main conversation per owner/project. Keep worker as historical lineage, never another project main. Owner/scope need explicit adjudication; paths are unavailable references, never mounted or executed. |
| `packages/storage/src/thread-message-schema.js`: `ensureThreadMessageSchema`, `orkestr_thread_messages`: composite `(thread_id,id)`, `position`, `cursor`, `role`, `state`, `source`, `phase`, `parent_message_id`, `event_id`, `client_message_id`, `external_id`, provider IDs, timestamps, `data` | `contracts::Message {message_id,sequence,actor_kind,text}`; `ConversationSnapshot` | Text/actor/order overlap only. Preserve original position/cursor and timestamp strings separately; do not equate cursor to v2 sequence. No source phase/state/parent/provenance fields. Source roles cannot all become owner. Provider IDs are historical only. Review/redact arbitrary `data` before copying. |
| `apps/server/src/modules/threads/thread-messages.controller.ts`: `messages`, `history` | No copy-only history endpoint | GET messages schedules native sync; GET history forces native sync. Neither is an inert exporter. Read only a separately prepared consistent snapshot; this audit invokes neither endpoint. |
| `packages/core/src/personal-agent-tasks.js`: `taskFromRow`, `normalizeContract`, `PERSONAL_AGENT_TASK_STATES`: `id`, `projectId`, `threadId`, `runId`, `idempotencyKey`, `dependencies`, `assignedWorker`, `acceptanceCriteria`, `scope`, `budget`, `completion`, timestamps | `orkestr-domain::Task {id,conversation_id,state}`; `TaskQueued/Started/Completed/Cancelled`; typed HTTP `TaskId` | Project is not conversation. No dependency/criteria/completion/import contract. Never synthesize Started/Completed events to fit old success. `blocked`, `needs_approval`, `failed` lack journal variants; retain exact source state in quarantined evidence. Running/queued remain dormant, not live workers. |
| `packages/core/src/agent-job-store.js`: `schema`, `rowToRun`, `rowToAttempt`; runs `run_key`, `spec_hash`, `state`, `output_json`, `error`, lease/retry/cancellation fields; attempts `(run_id,n)`; checkpoints `(run_id,seq)` | `contracts/runtime.rs::RunState` has queued/starting/running/cancel_requested/blocked/succeeded/failed/cancelled | Enum resemblance is not migration support. `pending`, `retrying`, `awaiting_approval`, `skipped` have no exact runtime counterpart. Preserve source values; no unknown-to-success/queued default. Strip live lease/retry authority. Pinned specs/checkpoints/output stay inert evidence. |
| Same job store: `effects` (`effect_key`, `run_id`, `args_hash`, `state`, `outcome`, `dispatched_at`, `result_json`, `ref`); task `completion_json` | Journal `TaskCompleted.result_ref`; HTTP `EffectId`, `ApprovalId` are IDs only | Result body/storage/acceptance and effect history import are absent. A nonblank ref does not certify content or completion. Cancelled/uncertain effects retain distinct redacted receipts in quarantine, cannot retry or consume old approval. No result inferred from assistant prose. |
| `packages/core/src/thread-resource-policy-store.js`: `orkestr_thread_resources` and `orkestr_thread_resource_grants`; resource type/ID, owner, revocation | HTTP `ResourceId`, `ResourceReadiness {local_git,local_oxrm}` | Readiness strings are not resource records or grants. No safe ownership/grant/retention import contract. Keep metadata references unavailable; no access grants, routes or sessions copied. |
| `packages/core/src/thread-sandbox-artifacts.js`: `materializeSandboxArtifact`, `resolveSandboxArtifactCandidate`; attachment `filename`, `sha256`, `source`, `materialized` | No artifact manifest/content import DTO | Verify copied bytes/hash under explicit snapshot root; reject traversal, absolute paths, symlinks escaping root and missing files. Keep original reference with quarantine reason; never substitute a fabricated artifact. |

`v2/crates/store-sqlite/migrations/0001_intake.sql` restricts persisted messages
to `actor_kind='owner'` and creates reasoning inbox/outbox records.
`MessageInput` accepts only client key/text. Posting historical messages would
change actor/time/provenance and could queue reasoning. **Do not use intake as an
importer.** The separate metadata journal described in
[event-contract-v1](../event-contract-v1.md) has no owner/scope/retention contract;
it cannot be treated as the authenticated HTTP model. Runtime DTOs explicitly
exclude provider-native identifiers. No current contract can express a lossless
historical import across these categories.

## Copy, ordering, lineage and identity rules for the next slice

A future exporter must take a coherent, immutable copied snapshot with source
version, schema versions, watermark, counts and hashes across registry, messages,
jobs, task/resource tables and artifacts. No discovery through environment/home
fallbacks. SQLite backup must include committed WAL data; JSON copies require a
coordinated consistency boundary. Preserve all original files read-only, including
divergent formats. Source checksums before/after must match. No deletion, schema
upgrade, retirement or reverse migration of legacy data is proposed.

Mapping keys must include explicit source instance, kind and full source primary
key: messages include thread ID, resources include type, attempts include run/n,
checkpoints include run/seq. Snapshot hash identifies evidence, not a new identity
on every repeat. Same identity/same canonical payload is duplicate; same identity
with changed payload is a conflict, never overwrite. Target UUID allocation and
its durable mapping journal are coordinator decisions, not supplied here.

Validate parents/root agreement, message parents, task dependencies, project and
run references before proposing import; reject missing/cyclic/cross-owner edges.
Never infer ownership or scope from names, paths or provider IDs. Order messages
by source per-thread position; preserve cursor separately. Detect duplicate
positions. Source timestamps are evidence, not global ordering. Parent-first
planning must not change original sibling/message order. Conflicted and orphaned
records remain in the private archive with exact exception counts.

## Redaction and exclusions

Default-deny fields outside reviewed allowlists. Text, arbitrary JSON, tool output,
filenames and URLs can themselves contain secrets: field names alone are not a
redaction guarantee. Sensitive snapshots/reports stay private; public fixtures use
fake IDs and harmless text only. Record omission reasons/counts and content hashes
only when policy permits; never publish secret values or low-entropy secret hashes.

Exclude credentials, OAuth/refresh tokens, private keys, cookies, auth sessions,
WhatsApp pairing state, browser/provider profiles, desktop leases, live resource
sessions, connector endpoints/phone routes and notification targets. Historical
provider IDs require private retention review and confer no session ownership.
Copy no runnable route, timer, webhook, campaign, outbox item, approval authority,
lease or retry schedule. Historical cancelled/unknown/uncertain effects may retain
redacted outcome receipts only in quarantine. Import cannot dispatch, reconcile,
retry, start a process, call a provider or activate a schedule. Imported history
never becomes personal memory without separate consent. Tombstone/deletion,
backup retention, owner/scope and forgotten-content replay policy remain blockers,
not invented API fields.

## Bounded next implementation request

Coordinator/Core: first approve a versioned **inert historical provenance and
mapping contract**, separate from intake and runtime admission. It needs source
composite identities, owner/scope decision evidence, original ordering/timestamps,
lineage, unsupported-state quarantine, redaction/retention/tombstone handling,
artifact references and same-key conflict semantics. Decide whether the metadata
journal is usable for history or needs an explicit conversion; do not change its
schema implicitly. Then implement snapshot-only validate/preview with no adapters
or inbox/outbox writes. Apply stays blocked until the coordinator supplies that
contract and store transaction boundary. This requests no heavy build admission.

Run `python3 v2/fixtures/migration-audit/validate.py` for deterministic fixture and
negative-case checks. It reads only its adjacent fixture and never imports product
modules. It proves audit-fixture consistency, not Rust compatibility, durable
idempotency, snapshot consistency, privacy scanning or a working importer.
Cargo/build, live snapshot, real importer/replay, provider and connector tests are
**unexecuted** by this audit.
