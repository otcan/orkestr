# Orkestr application interface redesign brief

Status: review proposal, 2026-10-11. This document changes no application behavior.
Scope: the authenticated Orkestr application and its setup, instance, and
thread surfaces. The static `orkestr.de` marketing website is out of scope.

## Product outcome

A new self-hosted owner should be able to start the Docker installation,
connect a real Codex or Claude Code runtime, pair an owned WhatsApp account,
receive a default thread and managed desktop, and complete one visible
WhatsApp-to-agent-to-WhatsApp round trip. Gmail, Outlook, files, automation,
and other connections follow that success. Hosted instances use the same daily
interface but a separate, clearly identified setup mode and instance boundary.

The daily interface should answer three questions without opening a diagnostic
panel: Where am I? What is the agent doing? What action needs me?

## Audit basis and limits

This is a read-only audit of the application source at
`4b52093608d829ca2ed85f316f9d9efff3448bcc`, plus the live thread/model
and desktop inventory APIs. The worker worktree was clean and equal to fetched
`origin/main` before this document. No production browser session, personal
account, or external service was opened. A screenshot pass remains necessary:
the available managed desktops are shared or purpose-bound, and no dedicated
desktop lease was assigned to this worker. Use an assigned managed desktop for
desktop/mobile screenshots before approving implementation; do not launch an
unmanaged browser or reuse an owner's sign-in profile for design QA.

| Surface | Current source evidence | Design debt or preserved strength |
| --- | --- | --- |
| Shell and routing | `apps/web/src/app/app.component.ts` defines 16 panel values and manually parses paths near `panelFromPath()`; `app.component.html` renders topbar, sidebar, thread views, and instance pages in one root template. | Broad navigation is nested in one screen, while canonical instance/thread links must continue to work. The root TS/HTML are 5,727/1,556 lines. |
| Visual system | `apps/web/src/styles.css` is 5,361 lines, starts with a mono font and green-on-near-black palette, and defines mobile rules mainly at 860 and 480 px. | Styling is global and dense. Preserve the useful responsive sidebar/composer behavior while replacing presentation with shared semantic tokens and reusable components. |
| First run | `onboarding-page.component.ts` has goal-based steps; `first-thread-wizard.component.ts` separately creates a thread/desktop and defaults `whatsappAccessMode` to `relay`. Its template asks for a WhatsApp choice and then starts a demo thread. | Two setup narratives compete. The Docker default should be owned WhatsApp; a hosted relay must be shown only when offered by that instance. The first successful message needs its own verified completion state. |
| Conversations | `app.component.html` gives each thread Chat, History, Delivery, Timers, Runtime, Settings, Parallel Work, and optional Raw views; `thread-message-list.component.html` already distinguishes phases, failures, retries, and attachments. | Useful evidence is scattered across tabs. Keep durable message/failure semantics and create one readable conversation with a linked activity timeline and explicit actions. |
| Connections | `user-connectors-page.component.ts` orders WhatsApp, Gmail, Outlook, Jira, Shopify, LinkedIn, and Browsers. The LinkedIn card only opens Desk; the Gmail card contains account controls and Outlook uses a device-code flow. | A browser workflow looks like an API connector. Separate Connected accounts from managed desktop tasks. Keep provider-specific OAuth state and per-account controls. |
| Desktops | `user-desk-page.component.html` lists running/other/attention desktops with open/start and a menu for share, restart, stop, reserve, release, and warnings. | Desktop lifecycle is substantial but visually subordinate. Make ownership, lease, viewer, and recovery first-class. LinkedIn opens only inside a leased managed desktop. |
| Instance, safety, health | `instance-settings-page.component.html` leads with attachment encryption, then reconciliation and a raw desired-state manifest. Pairing/approvals live in `security-challenges-panel.component.html` under Setup. A large `ops-page.component` exists but is not imported by the root app; `/ops` maps to instance settings. | The current status route is technical before it is actionable. Put pending approvals and repair actions in reach; keep raw manifest and audit detail behind Advanced. Preserve authorization checks. |
| Secondary tools | Launcher, files, vault, and timers have separate components, but share the root shell and global styles. | Keep their capabilities and deep links while standardizing page headers, empty states, tables, forms, and feedback. |

This is source-based evidence, not a claim that every live viewport was visually
verified. A visual QA pass must record screenshots at 390, 768, 1280, and 1920
CSS px for the screens below, with sanitized fixture content.

## Design principles

1. Lead with the next useful action. Put setup, connection repair, and pending
   approval actions where the user is already working.
2. Show one clear state per object: thread, turn, message, connection, desktop,
   and instance. Use words plus icons; color is supplemental.
3. Keep conversation content dominant. Put raw logs, transport details, and
   advanced controls behind deliberate disclosure without hiding errors.
4. Make self-hosting the ordinary path. Require no Orkestr cloud account for
   Docker; explain hosted capabilities only when the instance offers them.
5. Make user authority legible. Display which instance, account, thread, and
   receiving/sending identity an action will affect before destructive or
   external actions.
6. Prefer predictable navigation and fast feedback over animation. Preserve
   drafts, scroll position, deep links, and progress across reloads.
7. Use local assets and system fonts; no CDN or external telemetry is required
   to render the application.

## Information architecture and navigation

The global context switcher names the current instance and its deployment
mode (`Self-hosted` or `Hosted`). Its menu holds allowed instance switching,
account, and sign-out. It must never silently cross tenants.

| Level | Proposed destinations | What belongs there |
| --- | --- | --- |
| Primary | Conversations, Desktops, Connections, Automations | Daily work. Conversations opens the last thread or the first-run action. |
| Secondary | Files, Vault, Apps | Resources already present in the app. A compact More menu may hold these on small screens. |
| Safety | Approvals | Pending browser, tool, secret, or send approvals with requester and exact action; include history and expiry. Show a count only when action is possible. |
| Instance | Overview, Members/Accounts where supported, Health, Settings | Operator/admin capabilities. Self-hosted Overview emphasizes local runtime, backups, and upgrades; hosted Overview emphasizes instance identity, quota, and access. |
| Thread | Conversation, Activity, Automations, Files, Settings | Thread-specific views. Activity combines progress, runtime, delivery, and diagnostics; Settings holds model, workspace, bindings, and retirement. |

Keep existing `/setup/*`, `/connectors/*`, `/desktops`, `/settings`, and
canonical `/instance/:ref/thread/:id/*` links valid with redirects or route
adapters. Route work must preserve base-path hosting and browser back/forward.
Do not begin with a wholesale router rewrite: introduce route descriptors and
typed navigation behind the current link contract, then retire manual path
parsing after parity is proven.

### Desktop shell

```text
┌ Instance ▼ ─── Conversations  Desktops  Connections  Automations ── Approvals · Health ┐
│ Threads                         │ Thread title · state · agent/model           │ Activity │
│ Search, New                     │───────────────────────────────────────────────│ optional │
│ Pinned / Recent / Workers       │ User + assistant turns, progress, files      │ rail     │
│ status and unread count         │                                               │          │
│                                 │ Composer, attach, send, explicit interrupt    │          │
└─────────────────────────────────┴───────────────────────────────────────────────┴──────────┘
```

The activity rail is optional at wide widths and becomes a drawer at medium
widths. The thread list remains independently scrollable. A working state is
visible in the thread row and header; detailed events are chronological and
link to the originating message. Final answers are never replaced by a newer
turn's progress. Advanced controls remain permission gated.

### Mobile shell

```text
┌ Back · Thread title                         Actions ┐
│ State and latest activity                           │
│                                                     │
│ Conversation, one column                            │
│                                                     │
│ Composer above safe area                            │
├ Conversations ─ Desktops ─ Connections ─ More ──────┤
```

One mobile view is active at a time. The thread list is a full screen view,
not an overlay that obscures the composer. Activity, approvals, and advanced
controls open as labeled sheets with focus return and browser-back support.
Mobile navigation must not require hover or horizontal tab scrolling.

## Key journeys and screen specifications

### 1. Docker first run

1. **Welcome and local checks:** Show Docker volume persistence, reachable
   app URL, pairing/security requirement, and runtime availability. A failed
   check has a cause and a retry action; it does not erase completed steps.
2. **Choose agent:** Codex CLI login or an allowed Claude Code subscription
   profile. Show live readiness and what the choice means; an OpenAI API key is
   not presented as a Codex requirement. A missing Claude capability is a
   disabled option with an explanation, not a dead end.
3. **Connect owned WhatsApp:** Default to the self-hosted bridge, identify the
   owner-selected receiving and reply account, show QR and pairing progress,
   and confirm the exact chat/owner binding. Do not infer participants from
   old chats. The managed option appears only when the hosted capability is
   present and its trust boundary is explained. Worker 4 owns transport.
4. **Create workspace:** Offer the recommended local thread name and default
   managed desktop; let the owner change them before creation. Explain that
   the desktop is reserved only while in use. On failure, show which resource
   exists and allow resume without duplicates.
5. **First round trip:** Instruct the owner to send one short message from the
   bound WhatsApp chat. Show received → queued → agent working → final stored
   → outbound confirmed. A WebUI test message can diagnose the agent path but
   does not mark WhatsApp setup complete. Provide retry/repair for each failed
   link without repeating a successful send.
6. **Ready:** Open that thread with a visible success marker. Offer Gmail,
   Outlook, timers, files, and other optional connections as later tasks.

The journey is resumable after refresh and service restart. Hosted first run
uses the same milestone labels but starts with tenant/instance selection and
only offers managed WhatsApp or operator OAuth paths when enabled. It never
asks a tenant for the operator's app secret.

### 2. Conversation and agent activity

The thread header shows title, workspace, agent/executor, model/effort,
running/awaiting/failed status, and a single More menu. The timeline keeps
user input, assistant finals, plans, attachments, progress, and failure
evidence in order. Collapse verbose tool/runtime events by default; expand
them from the related turn. Show queued versus delivered versus answered
without conflating them. Place Approve, Stop, Retry, or Continue next to the
specific turn they affect, with confirmation for consequential actions.
The composer supports text, files, and an explicit `Reply in WhatsApp` target
when available. `Send now` must state that it interrupts an active turn.
Preserve existing optimistic messages, idempotency, draft recovery, encrypted
attachment handling, and exact thread/turn ownership.

### 3. Desktops and browser work

The Desktops index shows Ready, Busy/Reserved, Needs attention, and Stopped
states, assigned thread, lease owner, last activity, and primary action. A
detail view contains the managed viewer, current lease, share permissions,
warnings, and recovery controls. Opening a desktop acquires/renews the lease
through existing APIs; release is visible. LinkedIn appears as a suggested
desktop task (`Open LinkedIn in managed desktop`) and never as an API connector,
OAuth flow, or automatic access grant. No browser profile path or password is
shown in the normal UI.

### 4. Connections

Use one card pattern for WhatsApp, Gmail, and Outlook: identity, mode,
capabilities, health, last verified time, and one primary next action. Each
provider detail has Connect, Reconnect, permissions, accounts/defaults, and
Revoke access where supported. Gmail follows Worker 3's planned shared
status/action contract: Docker uses owner-supplied OAuth app credentials;
hosted tenants use the operator app; Read, Draft, and Send are separate
permissions and exact-send approval is server enforced. Display actual
granted/approved scopes and testing expiry; never imply approval from a
checkbox or expose tokens. Outlook keeps its device-code sign-in, but uses
the same state and recovery presentation where the backend supports it.
WhatsApp mode and pairing details come from Worker 4's server-owned status,
not client-inferred availability. Jira/Shopify stay optional and do not crowd
first run. Desktops are their own destination; LinkedIn is absent from the
API-connector list.

### 5. Instance, approvals, and diagnostics

The instance Overview begins with reachable/ready/degraded state, active
agent runtime, WhatsApp connection, desktop availability, and latest backup.
Each warning names the affected subsystem and a safe repair path. The raw
desired-state manifest, audit log, and detailed doctor output live under
Advanced diagnostics. Approvals show exact actor, target, effect, expiry, and
approve/reject actions; never use a generic approval that could apply to a
different message or account. Browser pairing remains a separate secure
entry route and uses the same visual language. Hosted instance management
shows tenant scope and account switch consequences; self-hosted mode does not
show irrelevant broker administration. Files, Vault, Apps, and Automations
reuse the same page shell and state patterns without changing their access
rules.

### 6. Remaining application screens

| Screen | Main content and action | Empty or degraded behavior |
| --- | --- | --- |
| Automations | Unified list of timers and scheduled work, next run, target thread, last result; create/edit/pause from an explicit owner action. | Explain that no schedule is active; show a repair link if scheduler health is degraded. |
| Files | Mount selector, breadcrumbs, file list, upload/download/preview, and protection state. | Distinguish empty folder from unavailable mount or failed decryption. |
| Vault | Owned items, thread grants, incoming requests, one-time share/request links, and approval queue. | Show how to add an item or request a secret without revealing values in list views. |
| Apps | Installed app cards and launch targets grouped by current instance. | State whether no apps are installed or the app registry could not load. |
| Thread settings | Workspace/repository, model and effort, WhatsApp binding, participant intent, and retire/delete behind a danger section. | Surface save validation and pending runtime changes; never make a destructive action the default. |
| Account and instance management | Current instance identity, deployment mode, permitted account switch, members where available, backups and updates. | Explain inaccessible child instance or stale health without switching context. |

## Component and token system

Use one application token layer, then components; avoid additional page-local
color schemes. Body text uses a system sans stack, with monospace reserved for
code, IDs, paths, and diagnostics. The proposed palette is restrained and
works without network font downloads:

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--canvas` | `#F7F8F6` | `#0E1512` | Page background |
| `--surface` | `#FFFFFF` | `#17211C` | Cards, panels |
| `--text` | `#17211C` | `#EBF3ED` | Main text |
| `--muted-text` | `#526158` | `#ABBBB0` | Secondary text |
| `--border` | `#D6DED8` | `#35443A` | Dividers and controls |
| `--accent` | `#176E4D` | `#7CD5A7` | Primary action/focus |
| `--accent-text` | `#FFFFFF` | `#062616` | Text on accent |

Candidate contrast calculations: light main text 16.5:1, muted text 6.5:1,
accent button text 6.2:1; dark main text 14.6:1 and accent button text
9.2:1. Validate every final state color in context, including disabled and
warning states. Use semantic state tokens rather than green/yellow/red alone.
Spacing scale: 4/8/12/16/24/32 px. Text scale: 12/14/16/20/28 px; body 16 px
and readable line height. Control height at least 44 px for primary actions.
Radius: 8 px controls, 12 px cards. Limit shadows to overlays and focus.
Offer light/dark following system with a saved override; do not let theme
selection affect application state.

Build shared `AppShell`, `PageHeader`, `ThreadRow`, `StatusBadge`, `ActivityItem`,
`EmptyState`, `ErrorState`, `ConnectionCard`, `DesktopCard`, `ApprovalCard`,
`Modal/Sheet`, `FormField`, and `ActionMenu`. Each component owns keyboard,
focus, loading, and error behavior. Icons need text labels; no emoji is a
sole control label. Avoid a new generic plugin framework.

## Responsive and interaction rules

At ≥1280 px use a persistent thread list and optional activity rail. At
768–1279 px keep the list and conversation, with activity in a drawer. At
<768 px use the one-column shell above. Test at 320, 390, 768, 1280, and
1920 CSS px, 200% zoom, portrait and landscape. Respect safe-area insets,
virtual keyboard resize, long file names, localization expansion, and
reduced-motion settings. No horizontal page scroll or clipped primary action.

Every async surface defines four states: loading (labeled skeleton or
progress), empty (one clear next action), error (plain-language cause plus
retry/repair), and ready. Show partial success where one provider or desktop
fails without blanking the whole page. For a sent message, distinguish local
pending, queued, running, final stored, and external delivery confirmation.
Avoid indefinite spinners: show elapsed time and a safe status link for work
that continues in the thread. Reconnect streams without duplicating turns.

Accessibility target: WCAG 2.2 AA. Make all actions keyboard reachable,
including nested thread rows; Enter and Space activate custom controls.
Provide visible `:focus-visible` across buttons, links, fields, menus, and
cards; do not suppress native outlines without a replacement. Trap focus in
modal dialogs, restore focus on close, and support Escape. Name icon buttons,
label form errors and required fields, announce asynchronous state changes
without reading every progress event aloud, and use headings/landmarks in
logical order. Honor `prefers-reduced-motion`; avoid color-only status and
ensure 4.5:1 normal-text and 3:1 control-boundary contrast.

## Worker interfaces and compatibility

- **Worker 3, Gmail:** Reviewed its architecture proposal at commit
  `42324d99cbbde31735e3cd9ae6fd8816e26b493d`. UI consumes a stable
  per-account status with mode, verified capabilities, grant health,
  reconnect/revoke state, and safe next action. The UI can request feature
  intent and exact-message approval, but it must not implement scope or send
  authority in the browser. Hosted and self-hosted share the presentation;
  credential setup differs.
- **Worker 4, WhatsApp:** Transport and mode implementation remain its scope.
  Proposed UI-facing contract: available modes, selected mode, paired
  receiving/reply identities, bound thread/chat, pairing phase, health,
  last inbound/outbound confirmation, and repair action. Treat these as
  requested fields, not current API guarantees. Confirm names and semantics
  with Worker 4 before coding. A Docker install selects owned WhatsApp by
  default; managed relay is offered only when server capability says so.
- **Existing APIs:** Preserve thread IDs, canonical URLs, persisted history,
  security principal/tenant boundaries, desktop leases, connector grants,
  vault secrets, and attachment encryption. UI grouping changes must not
  grant a permission or silently change which instance/account receives an
  action. No static marketing-site files are part of this plan.

## Implementation sequence for review, not authorization

Each phase is an isolated, non-destructive PR only after express approval.
Worker 3 and Worker 4 retain ownership of their backend tracks.

1. **Evidence and prototype:** Capture sanitized screenshots on an assigned
   managed desktop, map top tasks with owner review, and make clickable
   low-fidelity prototypes for first run, conversation, connections, and
   desktop/mobile shells. Freeze route and status contracts.
2. **Foundation:** Add tokens, shared primitives, app shell, accessible
   navigation, and route adapters behind existing API contracts. Keep old
   pages reachable until parity is demonstrated.
3. **First run:** Consolidate Setup and first-thread wizard around the Docker
   success milestone. Add resumable progress and test-message evidence;
   hosted mode branches only where capabilities differ.
4. **Daily work:** Redesign thread list, conversation, activity, approvals,
   composer, and mobile layout while preserving messages and draft behavior.
5. **Resources:** Redesign Desktops, Connections, Automations, Files, Vault,
   and Apps using shared components; integrate Worker 3/4 contracts as they
   land, with capability detection for older servers.
6. **Operations and polish:** Instance overview/health, diagnostics,
   accessibility remediation, performance, and visual regression baselines.
   Remove orphaned UI only after route and behavior parity is established.

## Verifiable acceptance criteria

1. A fresh Docker volume reaches a confirmed WhatsApp round trip through a
   selected real Codex or permitted Claude runtime, with one default thread
   and desktop. Refresh/restart resumes setup without duplicate resources.
2. Hosted setup identifies its tenant and offers only enabled managed modes;
   a tenant cannot edit operator OAuth secrets or select another tenant's
   thread, desktop, or account through the UI.
3. Every primary destination has an empty, loading, partial, error, and ready
   fixture. No failed API call leaves an indefinite spinner or loses a draft.
4. Conversation A/B concurrent turns keep their own progress and final
   messages. Retry, stop, approval, and WhatsApp reply target affect only the
   displayed thread/turn/account.
5. Desktop actions use existing leases and display the lease owner and
   recovery state. LinkedIn is reachable only as a managed desktop task; no
   LinkedIn API connect action appears.
6. Gmail/Outlook show truthful OAuth/account health. Gmail Read, Draft, Send,
   exact-send approval, reconnect, and revoke UI states match Worker 3's
   server-enforced contract; unsupported capabilities are labeled unavailable.
7. Keyboard-only completion works for first run, sending a message, opening
   activity, approving/rejecting, and releasing a desktop. Automated and
   attended WCAG 2.2 AA checks cover focus, labels, contrast, reduced motion,
   and screen-reader announcements at the target viewport widths.
8. Existing canonical/deep links, base-path hosting, browser back/forward,
   permissions, encrypted attachments, and thread drafts continue to work.
9. With a simulated slow API, each action gives visible feedback within
   200 ms; cached route transitions do not reload the document. Measure real
   first-run and conversation timings before setting stricter load budgets.
10. Sanitized screenshots for all key screens at 390/768/1280/1920 px are
    reviewed against the same component system. No production personal data
    enters screenshot fixtures or the public repository.

## Risks to resolve before implementation

- The current custom route parser, canonical gateway, and legacy redirects
  create deep-link risk; use route parity checks before replacing them.
- Setup, first-thread wizard, and connector pages overlap. Consolidation must
  preserve existing hosted/user/admin branches and incomplete setup records.
- Gmail and WhatsApp server status contracts are evolving on separate worker
  tracks. Use capability-based rendering and confirm exact fields before UI
  integration; do not copy provider policy into the browser.
- The large root component and global stylesheet increase regression risk.
  Extract by screen boundary, keep PRs narrow, and compare critical flows
  with sanitized visual and keyboard fixtures.
