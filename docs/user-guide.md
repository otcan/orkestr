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
- **Runtime:** the live Codex process behind a thread. Orkestr starts it in tmux
  so it can survive browser refreshes.
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
- attach to the underlying terminal
- sleep the runtime when it is idle
- inspect model, effort, context, and rate-limit status when available

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

### Connect Gmail and Browser Profiles

Gmail OAuth is part of the public setup surface. Browser-backed Gmail and
LinkedIn profiles are managed as local virtual browser profiles.

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

The installer records the default desktop, Gmail auth desktop, and manual
intervention desktop in runtime settings. Codex-aware skills should read
`orkestr whereiam --json` or `orkestr settings --json` instead of guessing which
browser profile to open.

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
  -> local tmux/Codex runtimes
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

On macOS, local installs intentionally avoid probing or launching the host
`codex` binary until you opt in. If macOS blocks `codex`, verify the binary
outside Orkestr first with `codex --version` and `codex login status`, then run
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
