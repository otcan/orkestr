# V2 full web release implementation

Owner-approved execution scope, 2026-10-18: replace the daily-use installation,
preserve **every currently used workflow**, then publish the web release. Native
iOS follows separately and is not a web release gate. This document supersedes
older first-wave-only authorization and iOS scheduling in the v2 plans; security,
consent, durability and independent acceptance requirements remain in force.

The integration baseline is `v2/s0-contract-integration` at `829a53dd`.
It has durable intake, role bindings and explicit fixture composition tests.
Ordinary production store admission and provider start are still unavailable.
This is an implementation baseline, not a production readiness claim.

## Ownership and immediate sequence

Reuse existing lanes and isolated worktrees. The coordinator owns integration,
shared contracts and dependency resolution; Core owns authoritative migrations.
Root release supervision tracks the gates and integrates cross-cutting helpers.
Parallel implementation is authorized subject to measured resource headroom and
the host build limiter. Never share concurrent writable target directories.

| Lane | Next concrete deliverable | Acceptance |
| --- | --- | --- |
| Core | Ordinary SQLite runtime admission, native bindings, leases, events, cancellation, acknowledgement, recovery and dispatch consumption | Actual store transactions survive process termination; replay never authorizes another start |
| Runtime | Connect ordinary store, supervisor and server; separate fast/deep/worker sessions; real Codex and Claude adapters | Each real provider separately completes a web-to-worker result with steering, Stop and restart evidence |
| UI | Authenticated conversation/Work flow, reliable drafts and reconnects, truthful progress, queue age and resource health | Input stays editable during 30-second deep turn; 10,000-message history remains usable |
| Isolation | Scope, containment, capability revocation and executor environment boundaries | Negative authorization and secret-inheritance cases pass |
| Installation | Isolated unprivileged launcher/package, version/doctor/logs/backup/restore | Clean install and upgrade preserve isolation and recover a backup |
| Migration | Current-used-workflow inventory, consistent snapshots, deterministic import and reconciliation | Repeat imports preserve identity/history, quarantine conflicts and keep imported execution dormant |
| Verification | Independent production-flow, recovery, security, performance and parity probes | Evidence names exact source, environment and limitations; fixtures cannot stand in for live execution |

Implement one complete ordinary-runtime vertical slice before widening fixture
infrastructure. Agree minimal additive `/api/v2` DTOs and versioned SSE events
for run state, steering, cancellation, approvals, evidence, integration readiness
and resource health. Credentials and execution authority never enter client DTOs.

The normal path durably accepts input independently of inference. A follow-up
steers the active turn when supported; otherwise it remains durably ordered with
an accurate pending state. Do not drop it or dispatch it repeatedly. Stop fences
new effects before requesting interruption. An interrupted transport does not
prove that an external effect was cancelled. Completion requires acceptance
evidence. No silent provider, account or billing-route substitution is allowed.

## Workflow and migration gates

Refresh the parity inventory against the currently deployed version. Every used
workflow has an owner, implementation decision and acceptance case. Missing
inventory or unresolved parity is a blocker, not permission to remove behavior.
Core chat and local projects still work without optional integrations installed.
Retained specialist tools are explicit external dependencies; the application
must not require the old server for core operation.

Snapshot/import validation preserves stable identity, provenance, order,
artifacts and consent. Project mappings are reviewed, not guessed from names.
Import unfinished runs as paused; timers, outboxes and approvals remain dormant.
Preserve existing disabled routes and held messages. Never automatically copy
credentials, activate historical outbound work or adopt live provider sessions.
Private account identities and deployment metadata remain outside this repository.

Rehearse both pre-write restore and post-write rollback. Reconcile in-flight
effects and export the v2-only delta before returning ownership. Any unsupported
reverse import has an explicit reconciliation procedure and cannot be described
as lossless. Each external channel has exactly one active dispatcher.

## Qualification and cutover

Required evidence is bound to the actual candidate commit, not an earlier green
PR. Resolve CI failures without weakening tests or classifying unexplained
failures as flakes. Independently test crashes around acceptance, dispatch, Stop
and completion; duplicate inputs; expired leases; provider loss; unknown effects;
scope isolation; permission revocation; approval replay; and credential exposure.

Performance gates on a declared environment are p95 below 250 ms for durable
input acceptance and local Stop fencing with ten concurrent synthetic clients,
and p95 below two seconds for opening a thread through the normal user access
path. Report model response time separately. Clean install, upgrade, backup
restoration and supported Linux architecture checks are also mandatory.

1. Produce `2.0.0-rc.1` through the release train with matching version, artifact
   and commit metadata after candidate gates pass.
2. Run the isolated candidate, then one controlled project with scoped channel
   ownership. Complete a 72-hour supervised stable daily-use soak. Material
   runtime, delivery or migration fixes restart the window.
3. Take a fresh backup, reconcile active work, migrate remaining projects and
   transfer dispatcher ownership under a durable fence.
4. Keep v1 data and rollback installation available with conflicting dispatchers
   disabled. Verify the full cutover before publishing `2.0.0`.

Execution and the gated release sequence are authorized. Do not request the
same architecture approval again. This does not authorize skipped gates,
destructive v1 removal, new message recipients, purchases, or disclosure of
private data. Work requiring a separate credential owner action must identify
the concrete missing capability after checking the existing local status path.

Report milestones, evidence and actual blockers. One assignment per bounded
deliverable and one report per changed result avoids coordinator queue floods.
Estimate later work from measured delivery and parity coverage, not token quota.
