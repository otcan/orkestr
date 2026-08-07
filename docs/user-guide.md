# Orkestr User Guide

This guide explains Orkestr as a product, not as a codebase.

Orkestr gives you a web cockpit for self-hosted Codex agents. The browser-facing
layer can be opened locally or exposed through a protected HTTPS/Tailscale URL.
The agent runtime, workspaces, browser profiles, connector credentials, logs,
and private overlays stay on your machine or VPS.

## Mental Model

- **Thread:** a named agent conversation and runtime target. A coding agent
  called `Repo reviewer` is a thread.
- **Workspace:** the folder where the agent works. Orkestr can clone a repo, or
  create a local git workspace when no repo is provided.
- **Runtime:** the live Codex process behind a thread. New coding threads use
  `codex app-server` so Orkestr can control turns, status, approvals, and
  imported Codex history directly. Older Orkestr Codex threads must be migrated
  once with `orkestr codex migrate`.
- **Status:** the current operating state: ready, starting, working, sleeping,
  awaiting input, or failed.
- **Connector:** an external surface such as WhatsApp, Gmail, a browser profile,
  or a private overlay connector.
- **Binding:** a saved link between a thread and a connector, such as one
  WhatsApp chat feeding one coding thread.
- **Virtual desktop:** a managed Chrome profile for browser work and login state.
- **Timer:** a scheduled prompt that wakes a thread later.
- **Runtime settings:** the non-secret setup contract that tells Orkestr and
  Codex-aware skills which Codex safety mode, managed desktop, and auth route to
  use.

## What You Can Do Today

### Run Codex Agents

Create named coding agents instead of managing anonymous terminals. Each agent
gets a workspace and can be controlled from the UI or CLI.

Common actions:

- create a coding thread
- wake or start the thread
- send a message
- switch between plan and code mode
- inspect the structured runtime state and history
- stop an active turn when you explicitly want to interrupt it
- inspect model, effort, context, and rate-limit status when available

Native Codex app-server threads resume lazily when a message, timer, or UI
action needs them. Orkestr does not auto-sleep Codex threads; active work is a
Codex turn, and `/stop` interrupts that turn instead of sleeping the thread.

The Codex setup page also lets you import existing Codex app-server threads.
Imported threads appear as Orkestr threads with their Codex history hydrated
into the normal conversation view.

### Migrate Existing Codex Threads

On a host that already ran Orkestr before the app-server cutover, run:

```bash
orkestr codex migrate --dry-run
orkestr codex migrate
```

The migration stops old live Codex tmux leases, rewrites existing Orkestr Codex
threads to app-server metadata, and creates app-server thread IDs for Codex
threads that did not have one. After this, Codex threads wake through
`codex app-server` only.

### Use Real Workspaces

When creating an agent, provide a repository URL if you have one. Orkestr clones
it into the managed workspace root. If you do not provide a repo, Orkestr still
creates a local folder and initializes git so the agent has a normal working
tree from the start.

This removes the old folder-picking flow. The user names the agent and Orkestr
assigns a sane workspace.

### Connect WhatsApp

Orkestr includes a local WhatsApp Web bridge with two account slots. You can:

- pair WhatsApp by QR code
- choose which account listens to messages
- choose which account sends replies
- create a WhatsApp chat from a thread
- bind an existing thread to that chat
- mirror Orkestr replies back into WhatsApp

For public docs, prefer fake chat names and fake IDs. If a public proof image
uses a real WhatsApp screenshot, keep it limited to non-sensitive public output
and do not include tokens, private chat IDs, phone numbers, local paths, or
session state. Real WhatsApp session state belongs under `ORKESTR_HOME`, not
in the repo.

The built-in local bridge is the public default. Legacy external WhatsApp bridge
compatibility is for private host deployments and must be explicitly enabled by
the operator with `WHATSAPP_BRIDGE_MODE=external` or
`ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED=1`.

### Connect Google Workspace and Browser Profiles

Google Workspace OAuth is part of the public setup surface. Browser-backed
Gmail and LinkedIn profiles are managed as local virtual browser profiles.

For contained or external users, use a public OAuth broker callback instead of
the private Orkestr UI hostname. Set `ORKESTR_CONNECT_PUBLIC_URL`, for example
`https://connect.example.com`, and register this Google redirect URI:

```text
https://connect.example.com/oauth/gmail/callback
```

The callback endpoint only completes the OAuth exchange. User tokens are still
stored in that user's scoped Orkestr data directory.

For WhatsApp-bound users, the preferred flow is `/connect google` in chat. That
creates a one-time link for the exact user-facing action that needs Google
access. Orkestr fixes that capability set on the server, shows it read-only,
then sends the user to Google. Google is the only place where the user selects
an account and grants or declines access. New connections request Gmail send
only; a later Gmail read, draft, or Calendar action starts a narrowly scoped
reconnect when that capability is actually needed. See [Google Workspace OAuth
verification prep](google-workspace-oauth-verification.md).

**Connectors > Gmail** is an account-management page, not a second permission
picker. Existing accounts can be reconnected, and a second account can stay
**Only when requested** so agents do not select it implicitly.

For Google OAuth verification, an operator can create a separate stable review
environment URL with `orkestr connect google --review-environment --thread
google-oauth-reviewer --json`. It is for a disposable isolated installation only.
The reviewer enters the separately supplied password and is taken into that
instance's normal Orkestr UI, directly on **Connectors > Gmail**. They can use
the actual Google connection flow and inspect the fixed, requested capabilities
in the same interface users receive. The reviewer VM must contain only synthetic test
data and no production threads, WhatsApp accounts, browser profiles, or other
users' data. Send the URL, password, and synthetic-account instructions only
through the existing Google review thread. See [Google Workspace OAuth
verification prep](google-workspace-oauth-verification.md).

For public job applications and LinkedIn outreach, use **Jobs** instead of a
mailbox-read or Calendar OAuth flow. It creates a private alert address for the
thread, keeps drafts in Orkestr, uses normal thread timers for follow-up, and
prepares `.ics` or Google Calendar prefill links for the user to confirm. See
[Job Application And Outreach Workflow](job-application-workflow.md).

Once granted, Orkestr exposes these optional Google Workspace workflows in chat:

- Prepare a Gmail draft without sending it.
- Send a prepared draft only after explicit approval of that send.
- Search or read Gmail when Gmail read access was selected.
- Watch a narrow Gmail query and deliver new matching signals to a thread.
- List Calendar events when Calendar read access was selected.
- Create, update, or delete an event on a calendar the user owns only after
  explicit approval of the effective event details.

Gmail signal watching uses persisted server-side rules with a minimum polling
interval and message-id deduplication. The Connectors page shows rule health and
supports **Check now**, pause, resume, and delete. Optional browser alerts use
the browser Notification API and must be enabled by that browser's user. They
are a convenience layer over the persisted Orkestr delivery; closing a browser
does not remove the watcher.

The rule is simple: account state stays local. Orkestr can coordinate the agent
with those accounts, but the public OSS repo must not ship tokens, cookies,
profiles, or private automation scripts.

### Use Virtual Desktops

Virtual desktops are managed Chrome profiles. They are useful when an agent
needs a logged-in browser surface or when a user wants to inspect the same
browser state the agent is using.

The desktop system is intentionally managed by Orkestr. Browser profile
directories stay under Orkestr-managed data paths or private overlays, and
agents should use the Orkestr desktop lease APIs instead of starting unmanaged
Chrome profiles.

Desktop authorization is thread-scoped. An administrator grants each thread
the exact desktops and permissions it may discover, lease, operate, and share.
Workers and task agents inherit their parent's grants and may only narrow that
set. A lease returns a fencing token; heartbeat, release, and stateful browser
actions must use the current token so a superseded holder cannot continue.

Existing installations can migrate without guessing from thread names:

```text
POST /api/desktop-grants/backfill {"dryRun":true}
POST /api/desktop-grants/backfill {"dryRun":false}
POST /api/threads/<thread-id>/desktop-grants
```

The migration uses only explicit thread desktop metadata and reports ambiguous
threads for attended assignment. `ORKESTR_DESKTOP_ACCESS_MODE=shadow` records
would-deny decisions during rollout; switch to `enforce` after grants are
reviewed. Legacy share links without a thread, boundary, and grant revision are
revoked in enforcement mode.

### Thread Resource Policy Rollout

Desktop grants are backed by the transactional thread-resource policy database,
not by a process-local permission cache. The same policy model also supports
oXRM resources: in `enforce` mode, a thread-scoped oXRM target resolver
considers only resources granted to that thread before explicit or
single-target selection. It never substitutes a different same-owner target
after a denied or stale selection. In `shadow` mode the same authorizer records
the would-deny decision but preserves legacy selection; it is not enforcement.

The shared-app XRM review surface currently has a share-session identity, not
an Orkestr thread identity, and is therefore deliberately instance-scoped. It
does not receive a thread grant by implication. Any new thread-driven oXRM
surface must pass its exact `threadId` and required resource permission into
the target resolver before it can be put in `enforce` mode.

Policies have an explicit empty state, so an administrator can deliberately
deny every resource of one type to a thread. A child records a snapshot marker
even when that snapshot contains no grants. When a worker or task-agent is
created, it receives a ceiling snapshot of its parent's then-effective grants
before it is made discoverable; an explicitly declared child scope can only
further intersect that snapshot. Subsequent parent additions do not widen that
child; parent revocations narrow it immediately. Resource records bind a native
identifier to its owner and tenant/VM boundary and status; grants provide only
use permission and never provision an instance, credential, endpoint, or
mailbox. The instance lifecycle must register an active oXRM or mailbox
resource with the admin/system `registerThreadResource` operation before an
administrator can grant it. Desktop keeps a small legacy catalog compatibility
path while existing desktop grants are migrated.
Decisions include the exact resource, policy revision, grant revision, and
resource generation for callers that need to reject stale work.

For clustered deployments, set `ORKESTR_THREAD_RESOURCE_POLICY_STORE=postgres`
and configure `ORKESTR_THREAD_RESOURCE_POLICY_POSTGRES_URL` (or the matching
`ORKESTR_THREAD_RESOURCE_POLICY_PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`,
and `PGPASSWORD` variables). PostgreSQL uses serializable, metadata-row-locked
whole-state transactions and never falls back to SQLite or JSON. It creates an
empty unified schema only: importing legacy desktop or JSON state is an
explicit, evidence-reviewed operator migration, never an automatic inference.
The doctor reports only `postgres` health and aggregate counts; it does not
expose connection details or credentials.

Use independent rollout modes per resource type:

```text
ORKESTR_DESKTOP_ACCESS_MODE=shadow
ORKESTR_OXRM_ACCESS_MODE=shadow
ORKESTR_MAILBOX_ACCESS_MODE=off
```

`desktop` preserves the existing shadow default, while `oxrm` is opt-in until
its explicit grants are configured. `mailbox` remains off until the mailbox
resource is registered and each destination thread receives exact mailbox
permissions. In mailbox `shadow` mode, ingress still follows the legacy
connector-inbox path and only emits a content-free unified
would-allow/would-deny evaluation; it neither delivers to listeners nor
quarantines a legacy message. Mailbox `enforce` mode enables exact-listener
dispatch. Mailbox permissions are `discover`, `read`, `subscribe`, and
`manage`; unknown permissions and wildcard grants are rejected. In non-off
mode, a listener is a durable record keyed by mailbox resource, exact thread,
normalized filter, and generation. Creating a listener requires an effective
`subscribe` grant; listing requires `read`; revoking requires `manage` and
invalidates pending deliveries. The listener APIs are `POST`/`GET`
`/api/mailboxes/:mailboxId/listeners`, `DELETE`
`/api/mailboxes/:mailboxId/listeners/:listenerId`, and
`GET /api/mailboxes/:mailboxId/delivery-status`. In enforce mode, inbound mail
is deduplicated once in the instance-owned inbox spool and creates one delivery
per active, authorized matching listener. No matching listener is
recorded in durable unrouted quarantine; it never falls back to an owner's
general inbox or thread. The status surface exposes listener count, pending,
unrouted, dead-letter count, and oldest pending lag. Delivery claim and state
transitions carry their own CAS epoch; policy/grant/resource/listener epochs
are rechecked before a thread append. If the transactional
policy store is unavailable, known mailbox ingress stays in the existing
instance-owned connector spool without any thread delivery. A bounded,
lease-protected pump reclaims due retries and expired claims; it also replays
`policy-unavailable` mailbox spool rows after policy storage recovers. Replay
uses the stable delivery client-message ID, so a retry cannot append twice.
The final policy/claim check runs immediately before append; a revocation that
begins after that cross-store check is still contained by the same deterministic
thread-message idempotency key. VM mailbox relay is separate and unchanged.
Break-glass is never an implicit admin bypass: it requires the exact target and
action, an admin's recent authentication, a reason, and a change reference; it
is audited before use and expires within fifteen minutes.

Run `orkestr doctor system --json` for the read-only thread-resource policy
report. It exposes only aggregate backend health, global and per-type modes and supported
rollback plans, resource/grant/policy/listener/delivery counts, queue lag and
dead letters, stale work, shadow mismatch totals, explicit-evidence backfill
counts, and break-glass audit state. It never includes endpoints, credentials,
message content, or resource/thread identifiers. Policy writes default to
`unified`. `legacy` and `dual` are fail-closed and reported as unsupported
until a real legacy writer exists; mailbox's only supported rollback is setting
its access mode to `off`, which keeps the legacy connector inbox path while
preserving unified records. Explicit oXRM/mailbox backfill accepts only typed
resource metadata plus explicit permissions; names and shared ownership are
reported as insufficient evidence rather than inferred.

The transactional audit outbox is append-preserving: this slice has no automatic
retention or deletion policy. The doctor reports pending, claimed, and delivered
audit counts without exposing audit contents. An audit sink claims a bounded
batch and marks only that claim as delivered after its own durable handoff.

The installer records the default desktop, Gmail auth desktop, and manual
intervention desktop in runtime settings. Codex-aware skills should read
`orkestr whereiam --json` or `orkestr settings --json` instead of guessing which
browser profile to open.

For chat-driven desktop access, `/desktop` is handled by the Codex agent as an
Orkestr desktop skill request. The agent creates the temporary phone link with
`orkestr desktop share`, then approves the pasted `desk-...` challenge with
`orkestr desktop approve`.

Before issuing a share, Orkestr verifies the managed desktop's process state,
noVNC bridge, Chrome debugging endpoint, and a small sample of the local VNC
framebuffer. A black or blank-white framebuffer is reported as an unavailable
desktop instead of producing a misleading share link. Orkestr performs one
safe restart attempt for a degraded managed desktop; if that does not recover
the screen, create a new share only after resolving the reported readiness
reason.

### Schedule Work

Timers can wake a thread and send a prompt on a cadence. Use them for recurring
checks such as:

- review a repository every morning
- check a mailbox query
- run a weekly status prompt
- continue a long-running thread later

Timer health is visible through the UI and CLI:

```bash
orkestr doctor timers
```

### Operate the Box

Use the system doctor to verify the runtime:

```bash
orkestr doctor
```

The doctor checks writable data paths, git, tmux, ripgrep, npm, Chromium or
Chrome, Codex login status, Caddy/Tailscale posture, and browser-pairing
security posture.

For host-native VPS installs, Orkestr can install a systemd service and an
on-box update watcher. The watcher pulls `origin/main`, rebuilds only when the
commit changes, and restarts Orkestr after a successful build. Use
`scripts/install.sh --systemd --track-main` when you want each `main` commit to
be installed as a rollbackable release under `/opt/orkestr/releases`.

## Public Facing Layer

Orkestr is not only a localhost UI. It is meant to have a public-facing control
surface when deployed correctly:

- The host-native VPS installer sets up the protected remote baseline out of
  the box.
- Caddy or another reverse proxy terminates TLS.
- Tailscale can provide private-network access.
- Browser pairing gates access from new browsers.
- The Orkestr service remains local to the server.
- Secrets and browser state stay outside the public repo.

The safe production shape is:

```text
Browser or WhatsApp
  -> HTTPS/Tailscale public entry
  -> Orkestr web/API layer
  -> local Codex app-server runtimes
  -> local workspaces and browser profiles
```

Do not publish a raw Orkestr API or terminal stream directly to the internet.

## First-Time Setup

1. Install locally with the one-line installer, or use the host-native VPS
   installer for a real server. Local installs create a user service by
   default, so Orkestr keeps running after the terminal closes.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | bash
   ```

   In a terminal, the installer shows the private local URL, asks only whether
   to `ENABLE YOLO MODE` for Codex, installs missing runtime tools when you
   approve it, and starts Orkestr as a local service. Press Enter to keep the
   safer default where Codex asks before higher-risk commands and stays
   sandboxed. Bind address, port, runtime paths, service behavior, and host
   Codex CLI probing stay on safe defaults unless you run with `--advanced`.

   For a clean local reinstall, use `--fresh`:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | bash -s -- --fresh
   ```
2. Open `/setup`.
3. Review Connections.
4. Configure secure access if the URL is remote.
5. Connect Codex Agent before sending tasks. You can create and inspect
   workspaces first. OpenAI API access is optional for connectors or skills that
   call OpenAI directly; it is not required for the default coding-agent path.
6. Pair WhatsApp if you want chat-driven agents.
7. Connect Gmail or prepare browser profiles if needed.
8. Create a coding agent.
9. Send a first task from the web UI, CLI, or WhatsApp.

On macOS, local installs use a private user-owned Codex CLI under
`$ORKESTR_HOME/codex-cli` by default and reuse the normal user Codex login from
`~/.codex`. If you prefer a host-installed Codex binary, verify it outside
Orkestr first with `codex --version`, `codex app-server --help`, and
`codex login status`, then run
`ORKESTR_ENABLE_HOST_CODEX=1 scripts/install.sh --local`.

Use the service commands for normal operation:

```bash
orkestr service status
orkestr service stop
orkestr service start
orkestr service logs
```

`scripts/install.sh --serve` is only for foreground development.

To uninstall a local Orkestr install:

```bash
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/uninstall.sh | bash
```

Use `--all` only when you also want to remove a source checkout outside the
managed `~/.orkestr-src` install directory.

## Typical Workflows

### Coding Agent From The Web UI

1. Click **New Coding Agent**.
2. Name the agent.
3. Optionally provide a repo URL.
4. Create the thread.
5. Send work in chat.
6. Use **Plan** or **Code** depending on the task.
7. Sleep the thread when it is done.

### Coding Agent From WhatsApp

1. Pair a WhatsApp account in setup.
2. Open the thread settings.
3. Create or bind a WhatsApp chat.
4. Send a message from WhatsApp.
5. Orkestr queues the message into the bound thread.
6. The agent reply is mirrored back when complete.

For non-admin or contained-user WhatsApp threads, configure an LLM sanitizer.
Admin sessions skip this sanitizer. Non-admin messages are fail-closed: if no
provider is configured, Orkestr rejects the message and notifies the WhatsApp
chat instead of silently dropping it. Non-admin users may request user-scoped
setup, browser pairing, desktop share, connector auth, or verification
challenges. The sanitizer still denies requests to approve, consume, bypass, or
forge those challenges.

Codex-backed sanitizer:

```bash
ORKESTR_LLM_SANITIZER_COMMAND_JSON='["node","/opt/orkestr/current/scripts/llm-sanitizer-codex.mjs"]'
```

Local Ollama-backed sanitizer:

```bash
ORKESTR_LLM_SANITIZER_COMMAND_JSON='["node","/opt/orkestr/current/scripts/llm-sanitizer-ollama.mjs"]'
ORKESTR_LLM_SANITIZER_OLLAMA_MODEL=qwen3:1.7b
```

### VPS Operations

```bash
orkestr status
orkestr version
sudo orkestr update
sudo orkestr rollback
orkestr logs
orkestr doctor
orkestr security approve <challenge-id>
```

For disposable test VPS machines, enable reset-on-update so each deploy starts
from a clean Orkestr state while preserving the env file and host proxy config.

## What Is Not In OSS V1 Yet

- hosted multi-user SaaS
- team RBAC
- Slack or Discord
- Dropbox as a built-in public connector
- a public plugin marketplace
- shipping private deployment overlays in this repo

Dropbox and other file-source connectors should use the same connector/binding
model when added: credentials stay private, the UI shows a clear binding, and
threads receive only the context they are allowed to use.
