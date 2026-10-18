# Orkestr 2.0 local evaluation, migration and rollback

Status: target runbook, 2026-10-18. The implementation tasks must make this executable and attach evidence. At this revision there is no verified v2 server binary, Cargo demo or installer. Do not run documentation-only commands as though those targets exist.

## 1. Separate installation contract

Keep `v2/rust-rewrite` in a new worktree. Never switch the checkout used by a live Orkestr service or another worker. The candidate's launcher must display its commit, schema version, home, bind address, execution mode and enabled connections before it can perform work.

Required namespacing:

| Resource | V2 rule |
|---|---|
| Data | Explicit `ORKESTR_V2_HOME`, no fallback to `ORKESTR_HOME` or provider home |
| API | Default host binding `127.0.0.1`; candidate example port `19822`, check availability and never kill an occupant |
| Docker | Separate Compose project `orkestr-v2-local`, volumes and networks; no fixed names that collide with 1.x |
| Cookie/device auth | V2-specific cookie name, session audience and device tokens. Ports alone do not isolate cookies |
| Process | Distinct server/worker identity and PID ownership; no matching/killing by an ambiguous process-name prefix |
| Providers | Separate runtime session namespace and explicit test profile. Never adopt active 1.x provider sessions |
| Workspaces | Fresh paths and isolated worktrees; no writable mount of the existing home or browser profiles |
| External channels | Off by default; no mirrored sends, email, scheduled outreach or webhook effects |
| Secrets | Separate protected store/handles; no copying OAuth tokens, cookies or pairing sessions automatically |

Resolve and validate canonical filesystem paths and mount identities; refuse overlap with 1.x data/workspaces, including symlink aliases. Run as an unprivileged user. Worktree isolation alone is not a security boundary and a localhost service still needs authentication and origin checks.

The local eval bundle should provide one documented command to start the new server/UI and one to stop only those processes, plus doctor, logs, version, backup, import preview and export. Those commands become supported only after implementation and clean-install tests.

## 2. Onboarding and provider setup

From a clean v2 home, create the first administrator under a local bootstrap guard, authenticate, then select one provider. In offline acceptance use an explicit test-fixture mode with a conspicuous simulated label. Normal operation may not silently substitute that fixture or a local model for a missing provider.

For real local evaluation the owner connects a supported test profile through the new setup flow. Verify the actual auth/billing route, model availability and supported runtime capabilities without exposing credentials. Use a harmless disposable project with no enabled outbound plugins. Development's existing subscription-powered coding agents and the new application's test-provider connection are different authorization boundaries.

This plan does not authorize logging out/relinking existing accounts, purchasing usage, enabling API overflow or editing production permission/ownership settings. CLI help and login metadata prove less than an actual guarded model turn. Report each evidence level separately.

## 3. Export a consistent source snapshot

Never import a changing live data directory directly. For SQLite, use its consistent backup API or a verified database-aware snapshot process; copying just the main file while WAL writes continue is not an acceptable backup. For multiple databases plus JSON and artifact files, coordinate a brief owner-approved snapshot/quiescence boundary or use an export implementation that records a coherent watermark and explicitly checks consistency.

The exporter writes an immutable manifest: source instance/version, snapshot ID, watermark, schema versions, object and relationship counts, content checksums, artifact paths/checksums and exclusions. Sensitive values are not written into a public report. Store the archive privately with restrictive permissions and appropriate host/volume encryption; do not claim that ordinary SQLite is encrypted at rest.

Keep the source snapshot read-only. V2 first imports only a copy into a fresh target. The importer has validate, dry-run and apply modes, with the apply mode requiring a target-instance identity. No source mutation, provider calls, Git writes, timer activation or connector sends may happen during validation/import.

## 4. Mapping and reconciliation

Maintain a versioned import journal and deterministic mapping `(source_instance, source_kind, source_id) -> v2_id`. Repeated import of the same snapshot is idempotent. Reject conflicting content under the same source identity instead of overwriting silently.

Preserve projects, main/legacy conversations, message order, original actors and provenance, timestamps/precision, task/run history, session lineage, forks, resource references, Git relationships, artifact metadata, memory consent and historical effect/approval receipts. A legacy worker chat is imported as inspectable history/run lineage, not automatically as another project main conversation. Do not classify every old root thread as a project without a mapping rule and preview.

Detect orphan references, cycles, missing artifacts, ambiguous session ownership and unsupported schema versions. Quarantine them and report exact counts; do not fabricate parents, completion or delivery. Preserve historical unknown outcomes as unknown. An old unsent message never becomes delivered.

Raw transcripts are not converted into permanent personal memory. Import only consented memory with source evidence and explicit scope. Deletion/tombstone rules apply to imported data and replay, and backup retention is disclosed.

Runtime side effects are dormant after import:

- Nonterminal runs are marked as imported/paused, never automatically resumed.
- Timers, campaigns, webhooks and outbound outbox items are disabled/quarantined.
- Approvals retain historical decisions but cannot authorize a new-instance effect until revalidated or explicitly reissued under the v2 target and policy.
- Native provider IDs are historical references until an authorized ownership transfer or new session is established.
- Credentials, WhatsApp sessions, browser cookie jars and active desktop leases are excluded by default.

Report source/target counts, mappings, exception counts and every excluded capability. The source files must have unchanged checksums after import. No silent partial success.

## 5. Acceptance ladder

**A. Offline sandbox.** Use fresh synthetic data and fake providers/connectors. Verify auth, ordered durable ingress while reasoning is busy, separate roles, task admission, cancellation, approval binding, worker completion evidence, stream reconnect and crash/reopen. No real external effects or credentials.

**B. Real local provider.** Owner-configured isolated subscription profile, disposable project, no outbound plugins. Prove real fast/deep native sessions and a separate supervised worker, status and limits, follow-up while busy, resume/blocked behavior, stop and evidence. No provider is marked verified based only on another adapter's success.

**C. Snapshot evaluation.** Preview then import a consistent copy of selected history. Compare counts, hashes, order, lineage, artifacts and privacy. Imported tasks/routes/timers stay dormant. Search and inspect in the new UI while 1.x remains authoritative for live operations.

**D. Controlled local workflow.** Explicitly designate one disposable workflow/project as v2-owned. Test one approved connector identity or test account only after duplicate-effect and rollback checks. Other 1.x projects continue normally.

**E. Daily-use replacement candidate.** Retained capabilities have passing parity; fresh install works without NestJS; iOS runs and reconnects; backups and both rollback cases below have been rehearsed. Owner chooses whether to continue, revise, or replace the old local installation. No mainline/production rollout is implied.

## 6. Required evidence matrix

| Area | Test | Required outcome |
|---|---|---|
| Admission | Concurrent same-key/same-body, same-key/different-body; kill after receipt | One durable message; conflicting payload rejected; acknowledged input survives process restart |
| Ordering | Interleaved fast/deep/worker responses and SSE reconnect | Stable per-scope causal order, no lost input or invented completion |
| Session identity | Different roles, resume/fork/fresh, missing native session | Roles remain distinct; loss is blocked or explicit authorized recreation with lineage |
| Work and effects | Stale lease, duplicate result, ambiguous dispatch timeout | Stale writes refused; verified completion only; uncertain effects not blindly retried |
| Hard stop | Stop while model is hung, effects before/after fence | New dispatch is fenced; already-dispatched outcome is reported honestly |
| Auth | Forged owner role, cross-project IDs, CSRF/origin, path traversal | Request denied before side effect; no cross-scope leakage |
| Plugin scope | Multiple identities, narrowed binding, revocation during run | Only eligible identity/capability works; revocation fences future effects |
| Memory | Save without consent, forget, export, replay, backup policy | Unconsented save refused; forgotten content not resurrected into active views/context |
| Import | Repeated apply, orphan/cycle, missing artifact, modified snapshot | Deterministic mapping; quarantined exceptions; source unchanged |
| UI | 10,000-message history, streaming + typing, drafts, offline/reconnect | Bounded rendering; no lost draft; truthful pending/blocked state |
| iOS | Simulator navigation, suspend/reconnect, then on-device auth/keyboard/accessibility | First-class client works; no claim that Safari-only testing proves native support |
| Installation | Separate homes/volumes/cookies/providers/processes | Candidate can stop without interrupting 1.x |

Benchmark at the actual local hardware and state the dataset/runtime version. Provisional M1 targets: durable message receipt and local hold transaction p95 under 250 ms for 10 concurrent synthetic clients on the declared local SSD fixture; UI remains editable during a 30-second fake deep turn. These are test targets, not measured results or a provider-response SLA. Measure receipt, first model response and final completion separately, with CPU/RAM and queue delay.

## 7. Two different rollback cases

**Before v2 has real writes:** stop only v2 and return to untouched 1.x. Keep or discard the isolated test home by explicit choice. No connector handoff is needed because none was enabled.

**After v2 has real writes:** stopping v2 is insufficient. First stop admissions and fence dispatch for the transferred scope, reconcile in-flight/unknown effects, record the final watermark, export v2-only messages/tasks/artifacts and receipts, and verify channel ownership is inactive before 1.x can take it back. Import into 1.x only through a separately tested reverse-compatibility path; otherwise retain v2 read-only and present a manual reconciliation package. Do not promise lossless reverse migration without that implementation.

For channel cutover, keep exactly one active dispatcher for the identity/scope, with explicit handoff generation and disabled old route. Never run two WhatsApp/browser clients against the same writable session files. Confirm the first approved send and receipt once, not by broadcasting a test across live chats.

No date-based forced sunset, automatic production replication, unattended credential transfer or removal of 1.x. A completed local evaluation creates an evidence-backed decision point, not an irreversible migration.
