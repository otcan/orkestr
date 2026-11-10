# ADR 0003: Opinionated Personal Agent and Codex/Claude Session Architecture

- **Status:** Proposed architecture decision, product direction agreed in owner discussion; implementation planning and migration review required
- **Date:** 2026-10-18
- **Program:** Jira ORK-534 (Orkestr Personal Agent; current planned children ORK-535 through ORK-558)
- **Repository:** otcan/orkestr
- **Relationship:** Extends and, on the conflicts listed below, supersedes [ADR 0002: Personal Agent Core Contract](0002-personal-agent-contract.md) and the original ORK-534 roadmap. It does not silently replace the existing database, event, approval, or security contracts.
- **Scope:** Product philosophy, primary UI, project defaults, resource sharing, conversational architecture, delegation, durability, trust, and acceptance criteria.
- **Non-goal:** This document does not approve deployment, change WhatsApp bindings, merge application code, or assert that subscription plans offer unlimited inference.

## 1. Product definition

Orkestr is an **opinionated personal assistant and Codex/Claude Code operator**. The owner speaks to one assistant, organizes ongoing work into projects, and lets Orkestr coordinate existing coding/execution agents. The owner should not need to wire together GitHub, Jira, a project database, desktops, agent threads, scheduling, and status tracking manually.

The product's central promise is **high-quality reasoning without a blocked conversation**. Responsiveness, trusted actions, structured work state, recoverability, and inspectability are product requirements, not optional UI refinements. It is insufficient to launch many agents or merely wrap Codex/Claude Code in another chat screen.

The design is **subscription-backed first, provider-independent by contract**. Where permitted by provider terms and actual supported runtimes, Codex/Claude Code sessions use the owner's existing subscription access. API-metered or local backends may be supported explicitly, but neither automatically substitutes for the selected reasoning engine. Subscription access is not assumed to be unlimited, always available, or free to operate.

## 2. Decision register

| ID | Agreed direction | Consequence |
|---|---|---|
| D01 | First-class native **iOS app first**, Android later, alongside the existing web and messaging surfaces. | Native mobile and its navigation must be part of the foundational experience, not a speculative future add-on. |
| D02 | One **global Orkestr main conversation** and **one default main conversation per project**. | Main project conversations are the normal user interface; internal workers are not exposed as mandatory chats. |
| D03 | Every global/project conversational scope has **two distinct persistent Codex/Claude Code sessions**, a **fast conversational session** and a **deep reasoning session**. | These are real runtime sessions, not a shallow API-only front end pretending to be Codex or Claude Code. |
| D04 | Complex work runs through **separate execution sessions**; all user-facing main conversations stay responsive. | Waiting for one synchronous CLI model call must not block incoming messages. |
| D05 | Reasoning sessions may persist, fork, or start fresh; workers can likewise be reused, forked, or newly created. | Orkestr stores the lineage, decisions, provenance, and outcomes, independent of provider session lifetime. |
| D06 | The reasoning layer selects the appropriate worker/strategy for each request and combines verified results. | Delegation is a reasoned decision, not a rule that every user message becomes a worker or Jira task. |
| D07 | **Resources belong to the project, not the chat/session.** | All project sessions and authorized workers resolve the same canonical resource bindings. |
| D08 | **Every project is immediately useful using the self-hosted local baseline.** New projects get local Git/workspace and a local OXRM workspace when those bundled services are healthy; shared managed desktops are leased only when needed. | Local project setup is durable and idempotent. GitHub, Jira, external OXRM, and WhatsApp are optional integrations, never prerequisites for project creation or the first task. Do not claim local OXRM readiness until its implementation and deployment are verified. |
| D09 | Shared desktops and other suitable resources may be reused across projects with explicit scoped leases. | A physical desktop or worker runtime is not automatically duplicated for every project. |
| D10 | Global reasoning can coordinate project reasoning sessions without consuming their user-visible chat capacity. | Cross-project questions are asynchronous fan-out/fan-in with partial results and explicit blockers. |
| D11 | **Orkestr owns routing, durable state, admission, lifecycle, approvals, and control signals**; models own language and reasoning. | A fast model cannot by itself authorize deployment, bypass an approval, or mark a task completed. |
| D12 | Trust requires visible evidence, provenance, status, consent, and clear control of external effects. | A worker's natural-language claim of success is not proof; memory is not an unconsented transcript copy. |
| D13 | Existing web, WhatsApp, execution, and audit infrastructure is reused; migration is additive and flagged. | The architectural change must not disrupt live routes, other projects, or prior work. |
| D14 | Orkestr supports **installable plugins** from the outset, with built-in first-party defaults and a consistent installation/configuration contract. | Integrations are not permanently hardcoded into application flows; third-party plugins may be installed, updated, disabled, or removed within policy. |
| D15 | **Module/plugin ≠ connection/identity ≠ capability ≠ project binding.** | One WhatsApp plugin may host several authorized phone identities; each project selects an allowed connection and the capabilities it can use. |
| D16 | A plugin can be **global (enabled for all eligible projects)**, **enabled for selected projects**, or **shared by a chosen set of projects**. | Instance-level install and security policy form the ceiling. Project selection can narrow permissions or choose an allowed connection, not elevate privileges. |
| D17 | Orkestr onboarding is **lightweight, progressive and connection-aware**, with an Integration Hub. | No need to connect every service before entering the assistant. The system presents a short standardized authentication/setup/health flow when a capability is needed. |
| D18 | Plugin setup and project resource provisioning are distinct. Plugins are installed/configured once; bundled local resources and explicitly enabled plugin resources are bound/provisioned per project. | Background workers reuse project resources instead of creating duplicates; external resources are optional and provisioned only through an enabled plugin/connection. Desktops are leased only when needed. |

### 2.1 Owner correction: self-hosted baseline and optional external integrations

The owner decision recorded on 2026-10-18 supersedes the earlier interpretation of D08 and the original §6 examples that required external GitHub, Jira, OXRM, and WhatsApp resources for every project. Orkestr is self-hosted first, initially distributed as a Docker-based stack on a user's computer or self-owned VPS. The existing first-run administrator username/password setup remains; iOS is a client, never the host.

Initial onboarding is intentionally minimal: reach a working installation, create the administrator, connect and verify one user-owned Codex/Claude Code subscription or model/API credential, then start the global conversation. No outside account signup or GitHub, Jira, OXRM, or WhatsApp account creation is mandatory before the first task. External integrations are offered progressively through the Integration Hub.

The intended Docker baseline includes the Orkestr control plane, local Git capability, a local OXRM service/workspace, the managed desktop infrastructure Orkestr already provisions, and Codex/Claude Code execution. These are product targets, not claims that each is currently included or ready. The open verification questions in §11 must be answered before promising the complete stack. Reuse the desktop pool and leases; do not allocate a desktop per project.

OXRM is proposed as the single user-facing project/task-management surface to avoid competing Jira, OXRM, and Orkestr boards. Existing Orkestr Agent Job and Personal Agent task, run/effect/approval/event records remain authoritative for execution and evidence until OXRM's actual task model and synchronization contract are verified. Do not remove existing task tables, migrate task truth, or assume OXRM capabilities without evidence.

### Interpretation: what "one thread" means

A **user-facing main conversation** is a single persistent, canonical transcript and UI entry for its scope. A project begins with one such conversation. Underneath it, Orkestr may maintain **two runtime sessions** for speed and deep reasoning and create any number of bounded background runs when necessary. Those runtime sessions do not create extra user-visible main threads.

The **global** main conversation is the default entry point into Orkestr. The user can ask it to talk to any project, compare projects, or coordinate work. A **project** main conversation is context-bound to that project and sees its authorized shared resources.

This corrects a potential ambiguity in the earlier architecture: "one main conversation" does **not** mean "one provider session" and "subagents" does **not** necessarily mean "visible worker chats."

## 3. Logical hierarchy and durable identities

~~~
Owner
  Global Orkestr assistant
    Canonical global main conversation (user visible)
      Fast conversational session (Codex or Claude Code, persistent)
      Reasoning session (Codex or Claude Code, persistent/forkable)
    Global coordination, approvals, task/event views
  Project A
    Canonical project main conversation (user visible)
      Fast conversational session (Codex or Claude Code, persistent)
      Reasoning session (Codex or Claude Code, persistent/forkable)
    Project resource bindings
      Repository / workspace, task board, structured data, desktops
    Durable tasks and background execution runs
      Worker session(s): persistent, forked, or fresh
      Native provider subagents may exist inside a worker run
  Project B
    Same pattern, separate project state and resource permissions
~~~

Canonical Orkestr identity is **not** a Codex/Claude session ID. Project, main conversation, message, task, execution run, resource binding, session, approval, event, and artifact IDs must be distinct, stable, and correlatable.

Suggested conceptual records (adapt the existing tables and APIs rather than inventing parallel storage):

- **Conversation:** scope (global/project), ordered owner-visible messages, stable ID, delivery/read cursors.
- **AgentSession:** scope, role (fast/reasoning/worker), provider and model profile, native session ID, parent/fork-from reference, lifecycle, context snapshot reference, version, heartbeat.
- **ProjectResourceBinding:** project, resource kind, logical resource ID, provider/external ID, provisioning state, permissions, sharing policy, secrets reference, lease if applicable.
- **Task:** intent, outcome, acceptance criteria, owner, project, policy, status, blockers, dependencies, and evidence references.
- **ExecutionRun:** parent task, selected worker session, runtime, workspace/desktop lease, resource grants, attempt/retry and cancellation state, progress, result/artifact references.
- **Event:** causation and idempotency keys, scope, actor trust class, source, timestamp, evidence and retention policy.
- **Approval:** exact requested effect, target, arguments/scope digest, expiry, decision, and one-time consumption.

Use the existing Personal Agent project/task/memory store, Agent Job runs/effects/approvals, canonical event normalization, thread records, desktop leases, repository/worktree facilities, and channel integration. An implementation may map several conceptual records to existing systems; this ADR is not authorization to create redundant databases.

## 4. Three responsibilities, actual Codex/Claude Code sessions

### 4.1 Fast conversational session

**Purpose:** Keep the main conversation alive and responsive, accept new input, display what was received, give a short accurate response when possible, and show current work state. Use a fast **Codex or Claude Code session** with an appropriately fast supported hosted model/profile. It should not be a small untrusted general-purpose LLM acting as the sole personal assistant.

- Input is the user's new message plus a small bounded summary of canonical state.
- Output is conversational acknowledgement, already-known status, clarifying questions where indispensable, and later progress/result presentation.
- It may classify an intent for routing, but **the Orkestr ingress/control plane** must durably enqueue the reasoning request independently of successful model generation.
- It cannot decide to execute a high-impact operation, mark a run complete, invent a status, accept consent, or expand its own resource grants.
- If the model is busy, down, or rate-limited, a deterministic UI/transport acknowledgement is preferable to delaying receipt. The assistant should distinguish "received", "reasoning", "executing", "awaiting approval", "blocked", and "verified complete".
- Do not turn every short conversation into a Task.

### 4.2 Deep reasoning session

**Purpose:** Actually solve difficult questions, plan work, decide whether to answer or delegate, choose workers and resources, evaluate evidence, and report recommendations. This is a **separate persistent Codex/Claude Code session**, configured with a suitably capable model/profile (the owner discussed stronger reasoning tiers such as Opus and higher-capability GPT models).

- It receives a durable ordered inbox, canonical project/global context, relevant project resources, policy and task/event summaries.
- It may answer directly without creating a worker if the reasoning can be completed within its own turn.
- For long or tool-heavy work it creates a bounded Task/ExecutionRun, selects an appropriate worker profile and workspace, and yields control; the caller does not await the run synchronously.
- It chooses **reuse**, **fork with a pinned context snapshot**, or **fresh session with explicit brief** based on context value, contamination risk, reliability, and cost.
- It can consult project reasoning sessions from the global scope using asynchronous requests; it must not silently take over their resources or impersonate the owner.
- Conflicting concurrent decisions or side effects are serialized through Orkestr's resource/task control plane.
- A long-running reasoning call is not itself a reason to block ingress. When steering a busy session is supported, Orkestr may use it; otherwise queue, create a safe fork, or preempt where authorized.

### 4.3 Execution session(s)

**Purpose:** Coding, browsing, tests, data processing, outreach, compiling, long research, and other substantive work. These are actual **Codex/Claude Code workers** and/or their native subagent facilities, supervised at the Orkestr run boundary.

- Each run is bounded by its task, acceptance criteria, permissions, resources, time/cost limits, and cancellation hooks.
- Workers can be persistent, forks of a relevant parent, or new clean sessions.
- Native Codex/Claude Code spawned subagents are an **implementation detail of a run**, not necessarily separate Orkestr user-facing threads. Record run-level lineage, status, resources, outputs, and evidence even when provider-internal subagents cannot be inspected.
- Create a separately supervised Orkestr worker only when independent lifecycle, permissions, resources, persistence, or auditability requires it.
- Preserve history and linked artifacts, but do not load every raw worker transcript into the main model's context.
- Completion requires reliable execution evidence and acceptance checks, not the worker merely writing "done".

### 4.4 Provider independence and constraints

Provider session/model/profile names are configuration, not product identity. Implement adapters around supported Codex and Claude Code capabilities rather than relying on a particular CLI steering command remaining stable.

Do not promise simultaneous model calls within a single provider session: subscription CLIs may serialize turns or throttle. If parallel independent work is required, use separately managed sessions/runs and explicit concurrency limits. Native steering is a useful optimization, **not the responsiveness guarantee**. Supported subscription authentication and automation must be checked against providers' actual product/terms constraints. Any API or local fallback is opt-in, visible, and separately accounted for.

## 5. Message and work protocol

**Invariant:** Every inbound message is acknowledged by transport and durably assigned an idempotent event ID **before** any model is relied upon. The reasoning path cannot hold the client request open for minutes.

1. **Ingress:** Receive from iOS/web/WhatsApp, authenticate actor and channel, persist message and scope with idempotency, assign event/cursor, and return transport acceptance.
2. **Fast path:** Schedule the fast session for a brief accurate acknowledgement or known-state answer. Show a deterministic receipt immediately if the model is slow or unavailable.
3. **Reasoning path:** Independently enqueue the same event into the correct global/project reasoning inbox with priority, causal order, resource context, and current control flags.
4. **Decision:** Reasoning responds directly or creates/updates a durable Task and bounded ExecutionRun. Orkestr validates capability grants and approval requirements.
5. **Execution:** The selected worker(s) operate in isolated or leased resources; Orkestr records heartbeats, tool/effect evidence, retry and stall signals. The conversation is still available.
6. **Result:** The control plane reconciles evidence and acceptance criteria, changes canonical task/run state, stores output artifacts, and emits a correlated event.
7. **Presentation:** Fast conversation publishes a concise update, reasoning can integrate the deeper result, and the user can inspect audit/history and continue chatting.

### While reasoning is busy

New owner messages always enter the fast path. Orkestr must not wait for a blocked reasoning CLI turn before accepting them. Prioritized messages such as "stop deployment" or "cancel the current run" trigger **deterministic control-plane holds/cancellation and effect gates first**, not merely an LLM instruction. The reasoning session subsequently receives the policy/control event and revises its plan.

Other follow-ups can queue, be steered into a supported provider session, or be routed to a supervised reasoning fork for timely independent analysis. Resulting decisions are reconciled in message/causal order. No two parallel forks receive implicit permission to perform the same external effect.

A fast reply is not the same as a full answer. A truthful "request received; analysis queued" is acceptable while complex reasoning runs, provided the eventual result or explicit blocker is delivered and inspectable.

### Continuation, recovery, and observability

Preserve native session references, the canonical transcript, reasoning decisions, task-run-event links, workspace and resource references, context snapshot lineage, outstanding approvals, and resume tokens. After process/device restart, pending reasoning and worker runs must be reconcilable. A lost session, expired credential, or provider quota becomes a visible blocked/needs-attention state, never an invented success.

## 6. Project resource contract

**A project is a locally functional working environment, not a folder of chats or a prerequisite to sign up for third-party services.** Project creation, including a shopping list, creates the Orkestr project and idempotently binds/provisions the local capabilities available in the self-hosted installation. Local readiness failures remain explicit blockers; no empty placeholder may be reported as ready.

| Resource | Default project behavior | Sharing and source-of-truth boundary |
|---|---|---|
| **Local Git/workspace** | Bind an on-disk repository/worktree capability, or create one locally if that is the verified implementation. GitHub is optional remote hosting/sync through its plugin. | One canonical project binding; workers use branches/worktrees as appropriate. Do not duplicate a repository per agent. Whether the bundled implementation should use ordinary on-disk repositories or a local bare Git service remains open. |
| **Project/task management** | Local OXRM workspace is the proposed user-facing surface when the bundled OXRM service is verified and ready. | Existing Orkestr task/run/effect/approval/event records remain execution and evidence authority until the OXRM mapping and sync contract are proven. Jira is optional via its plugin. Avoid two user-facing task boards. |
| **WhatsApp** | No external WhatsApp conversation is required at project creation. Pair an eligible user-controlled number/account only when requested. | Plugin connection, identity, project binding, consent, sender policy, and routing remain explicit. No sender or route changes are implied by this ADR. |
| **Desktop and execution** | Reuse the managed desktop pool and execution infrastructure already provided by the installation. | Lease on demand for a run; never allocate a dedicated desktop per project by default. Apply scoped access, isolation, cleanup, and release rules. |
| **Files, memory and integrations** | Bind local project file/artifact storage and eligible capabilities. | Existing memory consent, provenance, authentication, scoped permissions, and retention contracts remain authoritative. External plugins are optional and progressively configured. |

**Provisioning workflow:** Project creation durably creates the project and an idempotent job for required local bindings and resources. Each resource has its own state (`pending`, `provisioning`, `ready`, `needs_connection`, `needs_approval`, or `failed`); one unavailable optional plugin must not make the local project unusable. Required local stack failures are visible blockers with a precise remedy. Retries reconcile partial progress without duplicate local resources. Desktops are excluded from eager provisioning and leased only when a run needs one.

**External provisioning is opt-in.** GitHub, Jira, WhatsApp, email/Pingen, CAPTCHA, and other services are installable plugins, configured progressively through the Integration Hub. Automatic creation is permitted only for an explicitly enabled plugin with an eligible connection and policy grant. Use idempotency, explicit blockers, least privilege, audit metadata, approval/effect controls, and honest failure states. Development and tests use fake provisioners only; they must not create live external resources or alter production connections/routes.

**Isolation:** Project resource IDs belong to the project; runtime agents get only scoped capability grants or leases. Global defaults may be inherited but only narrowed per project, never escalated. A global assistant may request project status through an authorized interface, not unrestricted access to project secrets. Shared desktops must clear or isolate files, credentials and session state on reassignment.

## 6A. Installable plugin, connection and onboarding architecture

### Canonical layers

1. **Plugin package/module:** Installable, signed/verified where supported, versioned code declaring entrypoints, supported API contract, dependencies, installation lifecycle, permission requests, UI contributions, and capability manifests. Install once in the Orkestr instance; first-party plugins can ship preinstalled.
2. **Connection / identity:** A configured account or provider resource managed by that plugin. Examples: German and Turkish WhatsApp numbers, multiple email sending identities, separate GitHub accounts, Jira organizations, or a Pingen account. OAuth/pairing/API-key details and secrets belong here, not in project chats.
3. **Capabilities:** Specific declared actions and resources supported by a connection, such as `message.send`, `message.receive`, `repository.create`, `issue.create`, `data.query`, `captcha.solve`, `postal.send`, `desktop.lease`. Admission must enforce privileges on every invocation, not only in the UI.
4. **Project plugin binding:** A project-level authorization and choice of permitted connection(s)/capabilities. A plugin may be installed globally but unavailable to a project. A bound connection may be shared by selected projects with explicit scope and consent.
5. **Service/resource instance:** The actual remote or local thing provisioned for a project (repo, Jira project, OXRM workspace, WhatsApp conversation), with lifecycle and reconciliation independent of the plugin installation.

Plugins include but are not limited to **GitHub, Jira, OXRM, WhatsApp, email messaging, CAPTCHA, Pingen postal delivery, browser/desktop automation**, and other provider integrations. Core Orkestr **conversations, projects, tasks, execution, permissions, approvals, memory and event history are not plugins** and remain usable across plugin updates, failure, and removal.

### Plugin scoping, inheritance, and permissions

- **Installation:** Admin installs a plugin once at instance scope. Installation does not itself grant all projects access to all accounts.
- **Global enabled:** If instance policy allows it, the plugin's permitted capabilities can be inherited by newly created projects. A global utility such as CAPTCHA can be globally available with per-action controls.
- **Selected-project enabled:** Admin/project policy may enable a plugin only for named projects, such as a client-specific CRM.
- **Selected-project shared connection:** Several projects can use a centrally configured provider account, but each has an explicit binding. Example: one WhatsApp module manages three numbers while Moteks uses one configured number and another project uses a different one.
- **Overrides:** A project can disable inherited plugins, choose among eligible connections, and reduce capability permissions. It cannot widen beyond instance policy, provider scopes, or parent authorization. Global assistant access to project resources remains independently permissioned.
- **Secrets and trust:** Credentials live in the existing secret management mechanism. Third-party plugin code requires isolation, narrowly granted capabilities, version/update checks, and failure containment appropriate to the runtime; prompts cannot serve as the security boundary. State what is not isolated when a plugin has host/root capability.
- **UI extension:** A plugin may provide a constrained settings/setup panel or project tool surface through a versioned UI extension contract, not arbitrary replacement of Orkestr navigation or approval UX.

### Standard plugin onboarding contract

Each installable plugin advertises its name/version, capabilities, account multiplicity, authentication modes (OAuth, pairing, API key, managed), required scopes, health/test probes, project provisioners and teardown semantics. A uniform Integration Hub supports **Discover → Install → Configure connection → Test → Enable globally or for projects → Bind/provision**. A provider-specific form is rendered only when the manifest requires it; credentials are not printed in messages or logs.

**Progressive initial onboarding** is deliberately shorter: complete a working self-hosted install, create the administrator, connect and verify one user-owned Codex/Claude Code subscription or model/API credential, then reach the global assistant. No third-party integration is essential to the first conversation or task. Offer GitHub, Jira, WhatsApp and other plugin setup only when useful, with a precise connect/test flow. Do not force optional modules or external accounts before the user can begin.

**Reliability and lifecycle:** Installation, connection setup, scope changes and provisioning have independent states and audit trails. Verify connection health; show exactly which project bindings break on disable/uninstall; use safe updates and rollback; revoke grants without deleting historical task/event records. A plugin may fail while Orkestr's core remains available. Treat external side effects as idempotent and governed by the current approval/effect ledger.

### Examples

- A **shopping list** project works using local project storage and local Git. If the bundled OXRM service is verified and healthy, its local workspace is the proposed user-facing place for list items; Orkestr's task/run/effect/approval/event records remain execution evidence. No GitHub, Jira, WhatsApp, or desktop account is required.
- A **Moteks** project works locally first. GitHub, Jira, WhatsApp, or a Moteks-specific CRM plugin can be enabled and bound as needed; its data remains inaccessible to unrelated projects.
- **WhatsApp** is installed only once, but may expose multiple numbers as distinct connections; a project binds to its authorized number while project workers share that binding.
- A **CAPTCHA** or **Pingen** plugin can be installed but enabled globally, for selected projects only, or using different provider accounts with constrained capabilities, without installing multiple copies.

## 7. Mobile-first product navigation

iOS is a primary product home; Android follows the same logical contract later. The existing web app remains compatible. Suggested iOS navigation:

1. **Assistant:** the global main conversation, active tasks, cross-project status and recent results.
2. **Projects:** open a project into its **single main conversation**, with tabs/panels for Tasks, Files/Repository, Data/OX, Runs/Desktops, and Activity.
3. **Approvals / Attention:** pending high-impact actions, blockers, stalled jobs, permission and cost decisions, with evidence.
4. **History / Memory / Settings:** inspect what is stored, correct/forget/export consented memories, select model profiles, channel identities and notification rules.

The user should never need to inspect an opaque worker thread to know whether work finished. Workers may be exposed in an advanced inspectable execution graph, but not as peer conversations competing with the project main thread.

Trust is created through truthful status, explicit approvals, reversible controls, provenance, error visibility, and consistent navigation, not merely through owning a native application.

## 8. Scenarios and expected behavior

### A. Moteks: build a supplier dashboard

In the Moteks project main conversation, the owner requests a dashboard. The fast Codex/Claude session responds immediately that the request was received. The reasoning session checks the project repository, Jira task board, OX/data, available desktop, and current tasks; it creates a scoped implementation task and selects a Codex coding worker. The worker runs tests and attaches a pull request. The owner asks "include supplier ratings" during implementation. That message is accepted immediately and the reasoning layer safely updates the task or worker brief. Final status contains the PR, checks, and any deployment approval still outstanding; a worker's assertion alone is not marked complete.

### B. Global briefing: Moteks, academic research, and Swing Dance İzmir

The global main conversation asks for a single briefing. Global reasoning sends correlated read requests to the three project reasoning scopes. Each project checks its own canonical project/task status and evidence. The global fast session remains available for other messages, and the global response can provide partial verified results while a slow project reports pending or blocked. No project is silently marked successful because its assistant wrote a cheerful summary.

### C. "Do not deploy"

A deployment may be in progress in the project. The owner says "don't deploy that" in the global or project conversation. Orkestr's trusted ingress/control plane records the request and sets the relevant deployment hold or blocks an effect at its approval gate before depending on an LLM response. Fast conversation confirms the **actual** hold outcome. The reasoning session sees the event and adapts worker tasks. If an irreversible effect already happened, state it explicitly rather than implying a rollback.

### D. Architectural design while other work executes

The owner asks a difficult design question while several runs compile or browse. The fast session acknowledges; the reasoning session handles the architecture question itself or uses a bounded research worker. The existing long-running work continues independently. The owner can immediately ask a second question. A fork is allowed when the original reasoning session is busy, and its decisions are reconciled into the canonical conversation before affecting shared resources.

### E. Hobby checklist

The owner creates a shopping-list or dance-event checklist project. It is usable immediately with the verified local baseline and shares the existing managed desktop pool only if an execution task later needs a lease. A local OXRM workspace is the intended user-facing project-data surface, pending verification of its implementation and lifecycle. GitHub, Jira, and WhatsApp are optional plugin resources. Missing optional connections do not block the project; missing required local services produce a specific readiness blocker rather than fabricated success.

## 9. Trust, security, and persistence requirements

- Source of truth for task completion is verified Orkestr execution state with acceptance evidence, not model prose. Preserve the existing Agent Job effects and approvals contracts.
- Resource grants, sending external messages, spending money, modifying data, deploying, deleting, and sharing require existing policy checks and appropriate owner approval. Model prompt wording is not an authorization boundary.
- Distinguish owner-authored input, automation, delegated agents, provider outputs, web/connector content, and untrusted third-party instructions.
- Keep raw transcripts, short-lived context snapshots, curated opt-in memories, and immutable audit metadata as **different data classes** with explicit retention/export/deletion semantics. Follow ADR 0002's explicit-consent memory contract; this ADR does not authorize copying private chats into memory.
- Log agent provider/model profile, decision, run/session lineage, side effects, approvals, failures, and evidence links. Protect credentials and minimize raw payloads in events.
- Provide cancel/pause/hold without relying on steering. Idempotency and replay protection apply to ingress, task creation, effects, and external actions.
- Make model/provider unavailability, quota limits, degraded inference, stalled work, and unknown state visible. Avoid false assurances or fabricated status.
- Mobile auth, notification privacy, device storage encryption and credential isolation need a dedicated threat model before native release.
- Enforce cost/concurrency quotas and background worker limits per owner and project, with explicit override and visible usage.

## 10. Nonblocking and correctness acceptance tests

The first acceptance milestone is an end-to-end proof, **not** only a beautiful mobile chat view.

Onboarding acceptance must additionally prove that a fresh self-hosted Docker installation can create its administrator, connect and verify one supported user-owned reasoning provider, and start a useful main conversation and local project without GitHub, Jira, OXRM external accounts, or WhatsApp setup. Test local stack health/readiness and idempotent project provisioning with fake provisioners; no live external resource creation is permitted in development tests.

- **AT-01 Receipt while busy:** A long-running reasoning/execution turn does not prevent a new message being durably accepted, visibly acknowledged, and shown in the same main conversation. Measure p50/p95 receipt, fast response, and reasoning latency separately.
- **AT-02 Strong reasoning:** A difficult prompt reaches the capable persistent reasoning session, not solely a lightweight router; it either answers with evidence or records a work item and an explicit pending state.
- **AT-03 Real session architecture:** Verify separate native provider session IDs for fast and reasoning roles, and separately supervised execution runs. Model/profile changes retain the Orkestr conversation identity.
- **AT-04 Cross-project coordination:** A global request to three project scopes returns correlated independent responses, a partial result when one is blocked, and no unauthorized cross-project reads.
- **AT-05 Mid-run modification:** A user follow-up updates or supersedes the authorized task without duplicate external effects or lost messages.
- **AT-06 Hard stop:** A stop/deployment hold is enforced through the control plane while the reasoning model is busy. The UI states whether the target effect was still stoppable.
- **AT-07 Resource reuse and isolation:** Two project sessions see the same project resource bindings; a leased desktop can be reused safely, and another project's private resources stay inaccessible.
- **AT-07a Project provisioning:** A new shopping-list project and a new software project are useful without external accounts, use the bundled local Git/project baseline, and create/bind any verified local OXRM workspace idempotently. Fake optional-plugin provisioners exercise GitHub/Jira/WhatsApp workflows, retries, partial failure and exact blockers without contacting live services. Desktops are leased on demand, not instantiated per project.
- **AT-07b Plugin inheritance:** Install a plugin once, configure multiple connections, enable globally or for selected projects, restrict capabilities per project, and verify a disabled project cannot invoke it. Admin restrictions cannot be broadened by projects.
- **AT-07c Progressive onboarding:** A fresh user can reach the assistant without connecting every optional plugin, and can complete any missing resource authentication contextually. Provider setup/health and partial provisioning states are truthful.
- **AT-08 Worker choice and lineage:** Reasoning selects reuse, fork, or fresh worker with traceable rationale; history and outcome can be inspected after provider sessions expire.
- **AT-09 Restart/recovery:** Restart mid-run and recover message ordering, pending tasks, resource leases, lineage, approvals, and final evidence or blocker.
- **AT-10 Trust gates:** An untrusted worker cannot mark work completed or approve an effect; explicit owner consent is required for durable personal memory.
- **AT-11 Native navigation:** On iOS, open global assistant, enter one project's main conversation, inspect tasks/resources/runs and approvals, and return without losing context; Android can be delivered subsequently.
- **AT-12 Compatibility:** Personal Agent flag off leaves existing web, threads, WhatsApp routing, password handoff, and Agent Job behavior unchanged; no implicit deploy.

Latency targets must be measured against the real subscription-backed runtimes and available hardware. A fast-looking acknowledgement cannot count as proof that deep reasoning finished.

## 11. Changes to the existing ORK-534 plan

The original 24-task backlog remains a useful implementation skeleton, but **it is not fully consistent with the latest product decisions**. This ADR should be linked on ORK-534 and reviewed against children ORK-535 through ORK-558 before workers follow outdated assumptions.

| Area | Change required |
|---|---|
| Product charter/architecture (ORK-535/536) | Add global + per-project single canonical conversation, two actual Codex/Claude sessions per scope, native-first direction, resource registry, execution lineage and durable routing contract. |
| Project/task foundation (ORK-537 through 540) | Add a usable local project baseline, verify local Git/OXRM resource contracts, idempotent resource binding/reconciliation, correlated message/run events, strong acceptance evidence, and durable asynchronous inbox/replay semantics. Keep GitHub/Jira/WhatsApp provisioning optional behind plugins and fake provisioners in development. |
| Assistant/memory/inference (ORK-541 through 545) | Keep opt-in memory and replace any assumption that a lightweight local model is the mandatory or authoritative conversational/reasoning brain. Define fast-vs-deep subscription session profiles with optional explicit fallback. Existing local adapter work may remain a supported capability. |
| Delegation (ORK-546 through 551) | Make worker sessions background-only by default, expose lineage and reasoning-driven worker selection (persistent/fork/new), reliable cancellation, priority, and per-project resource leases. |
| Interface (ORK-552 through 555) | Extend the web UI without regressions, but **add foundational iOS work** for navigation/global-project conversations/resources/approvals and an Android follow-up. Include an Integration Hub showing plugin installation, multiple accounts, global/project scoping, health and provisioning status. Do not treat mobile as indefinitely deferred. |
| Acceptance/release (ORK-556 through 558) | Add the acceptance cases above, particularly fast receipt while reasoning is busy, cross-project routing, stop/deploy safety, default local project readiness, optional plugin provisioning, plugin scoping/isolation, progressive onboarding, recovery, and iOS navigation. Continue feature flags and separate release approvals. |
| Additional plugin platform scope (gap assessment required) | Specify installable plugin package/manifest, isolation, install/update/uninstall contract, connection/identity management, health, capability registration, global/project inheritance, resource provisioners, and developer/UI extension APIs. Add scoped Jira issues only where the current backlog does not cover them. |

**Implementation sequencing proposal:** (1) approve the conversation/session/resource contract; (2) wire durable ingress + fast/deep runtime sessions against existing thread and Agent Job primitives; (3) prove nonblocking end-to-end with one project and one worker; (4) add global-to-project fan-out/fan-in, resource bindings, reuse/fork/new, controls and audit; (5) build iOS navigation against the same APIs, retain web compatibility; (6) run independent acceptance, rollout planning and Android design. Keep already-merged OP work intact and add changes incrementally.

Do **not** rewrite every Jira child or launch new workers automatically just because this document is recorded. First perform a gap review, name the owners, specify dependencies, and change only affected issues. No production deployment follows from this ADR.

## 12. Open engineering choices, not reversals of the product decisions

1. What the existing OXRM implementation is, how it is deployed today, which container image/storage/APIs it uses, what its project/task lifecycle, dependencies and approvals actually support, and how backup/readiness are guaranteed. Verify rather than infer whether it is already part of Docker installation and whether its task model can represent Orkestr work without duplicate sources of truth. Until that evidence exists, keep Orkestr task/run/effect/approval/event records authoritative for execution and do not promise OXRM features.
2. Whether bundled Git means ordinary on-disk repositories/worktrees or a local bare Git service, and how repositories are backed up and isolated.
3. Which components are included in the minimal Docker stack versus requiring the full managed desktop runtime; establish minimum resource requirements and readiness checks for a new installation.
4. Which iOS implementation framework best reuses the current web UI and runtime securely; how push notifications and offline state are handled; Android sequencing.
5. How the installed Codex/Claude Code runtimes expose session resume, fork, steering, model selection, concurrency, cancellation, and provider-supported subscription authentication. Validate each capability in tests.
6. Fast and deep model profiles per provider, explicit fallbacks, practical latency and budget ceilings; never assume a specific branding/model will remain available.
7. The boundary between internal provider subagents and durable independently supervised Orkestr workers; preserve lifecycle evidence at whichever boundary is supported.
8. Exact local project provisioning dependencies, health/readiness, backup/recovery and resource limits; external provisioning policies, provider quotas, connection eligibility and approvals apply only to explicitly enabled plugins.
9. Storage/retention details for full conversation history versus summarized reasoning, mutable project state, and consented long-term memory.
10. Concurrency/scheduling semantics when a project receives several follow-ups while a reasoning session is busy; enforce causal order and duplicate-effect prevention.
11. Exact plugin distribution/signature/sandbox/versioning and UI extension enforcement, especially where existing runtimes may have host-level privileges.
12. Which WhatsApp connection/provider supports optional project conversation provisioning or binding and how unsupported API operations are surfaced accurately.

## 13. Definition of done for this decision record

The record is complete when committed to a reviewable repo branch, linked from the ORK-534 Jira program, and explicitly marked as the newer product-direction contract where it conflicts with the old roadmap. Implementation is **not complete** merely because documentation exists. The next controlled step is a gap analysis and targeted Jira issue updates with owner review, preserving ongoing work and deployment gates.
