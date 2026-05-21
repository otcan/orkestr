# Orkestr

Orkestr is a self-hosted agent workstation for running Codex from a browser, CLI, or WhatsApp.

It gives you a public-facing web layer for setup, chat, status, pairing, and operations while keeping the actual agent runtime on infrastructure you control. Create named Codex threads, give them workspaces, start or sleep them, inspect status, connect WhatsApp or Gmail, attach virtual desktops, and review logs from one cockpit.

> Public alpha. Do not expose Orkestr directly to the public internet. Keep it bound to `127.0.0.1` unless you have put it behind a trusted private network, TLS, and an auth boundary.

Start with the [user guide](docs/user-guide.md), then use the quickstart below when you are ready to install.

## Why Use Orkestr

- **No OpenAI API credit meter for the default Codex path.** Use your existing Codex login instead of wiring every agent task through paid API calls.
- **Persistent agents, not simple chat automation.** Orkestr manages real Codex sessions with workspaces, queues, status, recovery, logs, and browser access.
- **Timers for recurring work.** Agents can wake later, continue a task, check a repository, or run scheduled prompts without reopening an IDE.
- **Real work surfaces.** Connect WhatsApp, Gmail, LinkedIn browser profiles, virtual desktops, and future local connectors into the same agent control plane.
- **User-controlled infrastructure.** Keep workspaces, runtime state, connector sessions, and private overlays on a laptop, workstation, private VPS, or k3s host you control.

## Why This Exists

Coding agents are useful, but the useful work usually lives outside the chat window:

- a repository on disk
- a browser profile with user-owned login state
- a WhatsApp thread where the user actually gives instructions
- recurring tasks that should run without reopening an IDE
- logs that explain what happened after the agent wakes up

Orkestr makes those pieces explicit. The default target is a single developer running agents on a laptop, workstation, private VPS, or k3s-backed demo host.

## What Orkestr Lets You Do

- **Run multiple Codex instances:** create named coding agents and worker threads instead of juggling anonymous terminal panes.
- **Control agent lifecycle:** start, wake, sleep, attach, and inspect ready/working/error status from the web UI or CLI.
- **Give every agent a real workspace:** clone a repo when you have one, or let Orkestr generate a local git workspace when you do not.
- **Route WhatsApp into agents:** connect one or two local WhatsApp Web accounts, create or bind a chat, and mirror agent replies back to the conversation.
- **Connect mail and browser accounts:** configure Gmail OAuth, keep browser-backed Gmail/LinkedIn profiles local, and add private connector overlays without putting credentials in the public repo.
- **Use virtual desktops:** launch managed Chrome desktop profiles for browser work, login state, and future CDP-backed tasks.
- **Schedule recurring work:** create timers that wake a thread and send a prompt on a cadence.
- **Operate the box:** run `orkestr doctor`, watch logs, reset disposable VPS state, and keep a host-native install updated from the server itself.

Dropbox and other file-source bindings are not shipped as public OSS V1 connectors yet. The intended path is the same connector/binding model: keep private credentials in overlays, then bind those sources to an agent without copy-pasting context into chat.

## Quickstart

Orkestr has two supported setup paths:

- **Local or beginner setup:** use Docker Compose. This is the fastest way to try Orkestr because the image includes Codex, tmux, git, ripgrep, Chromium, and the compiled web app.
- **VPS setup:** use the host-native systemd installer. This is the right shape for a real server because Caddy, Tailscale, browser desktops, service logs, and pairing approval are host-level operations.

### Local Docker

```bash
mkdir orkestr && cd orkestr
curl -fsSLO https://raw.githubusercontent.com/otcan/orkestr/main/docker-compose.yml
curl -fsSLo .env https://raw.githubusercontent.com/otcan/orkestr/main/.env.docker.example
docker compose up -d
```

Then open:

```text
http://127.0.0.1:19812/setup
```

In setup, choose what to add first, then connect the required accounts. For
Codex, use **Open Codex sign-in** for device authorization or **Connect Codex
with API key** when this runtime should authenticate Codex that way. Orkestr
checks `codex login status` before starting a coding thread, so a raw Codex
login menu is treated as setup work instead of being opened inside the agent
runtime. Runtime state, including Codex auth, is stored in the `orkestr-data`
Docker volume. Edit `.env` before starting the container to provide optional
OpenAI direct API access, Tailscale/Caddy settings, OAuth credentials,
workspace roots, or overlay settings. If you upload or paste an `.env` during
setup, Orkestr reads that file as runtime configuration and stores it with the
same local runtime state.

### VPS Host-Native

```bash
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | sudo bash -s -- --systemd
```

The host-native installer creates:

- `/opt/orkestr/app` for the cloned application
- `/opt/orkestr/data` for `ORKESTR_HOME`
- `/opt/orkestr/workspace` for agent workspaces
- `/etc/orkestr/orkestr.env` for server-local configuration
- `/usr/local/bin/orkestr` for the CLI
- `orkestr.service` for systemd

Then use normal server commands:

```bash
systemctl status orkestr
journalctl -u orkestr -f
orkestr doctor
orkestr security approve <challenge-id>
```

The host CLI is safe to run from a root SSH session. It drops to the
configured `ORKESTR_RUN_USER` before touching Orkestr state, so files under
`ORKESTR_HOME` remain writable by `orkestr.service`.

Edit `/etc/orkestr/orkestr.env` for optional OpenAI direct API access, OAuth, Caddy/Tailscale HTTPS, and private overlay settings. Keep the service bound to `127.0.0.1` and put Caddy/Tailscale in front before remote browser access.

### On-Box Update Watcher

For a personal VPS, keep deployment on the box:

```bash
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | sudo bash -s -- --systemd --auto-update
```

That installs `orkestr-update.timer`. The timer runs `orkestr-update` every two
minutes, fetches `origin/main`, rebuilds only when the commit changes, and
restarts `orkestr.service` after a successful build. It keeps
`/etc/orkestr/orkestr.env` local to the server.

For disposable test VPS deployments, set `ORKESTR_RESET_ON_UPDATE=1` in
`/etc/orkestr/orkestr.env`. Successful updates will wipe `ORKESTR_HOME` and
the workspace root before restarting the service, while preserving the env
file and host proxy setup. Use `ORKESTR_RESET_OVERLAY=1` only when the overlay
is also disposable. Run `orkestr-reset-state` for a one-time manual reset.

Useful updater commands:

```bash
systemctl list-timers orkestr-update.timer
journalctl -u orkestr-update -f
orkestr doctor
orkestr-update
orkestr-reset-state
```

Local clone flow:

```bash
git clone https://github.com/otcan/orkestr.git
cd orkestr
./scripts/install.sh --local --serve
```

Local Docker build flow:

```bash
cp .env.docker.example .env
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

Then open:

```text
http://127.0.0.1:19812/setup
```

Manual development flow:

```bash
npm ci
npm run build
npm start
```

Useful CLI commands:

```bash
npx orkestr-oss serve --open
npx orkestr-oss thread create "Repo launch reviewer" --cwd "$PWD" --executor codex
npx orkestr-oss send repo-launch-reviewer "Inspect this repo and list launch blockers."
npx orkestr-oss attach repo-launch-reviewer
```

## First Demo

Run the public dry-run coding-agent demo:

```bash
npm run demo:coding-agent
```

That demo starts Orkestr with a temporary local home, creates a coding-agent thread, prepares the virtual desktop profile, queues a repository-review task, and prints the public log. It does not require WhatsApp, Gmail, LinkedIn, or Codex credentials.

For a real Codex run, use the Docker local setup, the host-native VPS setup, or see [examples/coding-agent-demo/README.md](examples/coding-agent-demo/README.md).

Optional real Codex demo mode:

```bash
node scripts/coding-agent-demo.mjs --real-codex --repo "$PWD"
```

Regenerate the local demo storyboard asset:

```bash
npm run demo:record
```

Public demo logs live in [docs/demo-logs](docs/demo-logs).

## Architecture

```mermaid
flowchart LR
  User[User browser or CLI] --> API[NestJS API]
  WhatsApp[WhatsApp account] --> Bridge[Built-in local WhatsApp bridge]
  Bridge --> API
  API --> Store[(ORKESTR_HOME data, config, events)]
  API --> Threads[Thread runtime API]
  Threads --> Tmux[tmux session lease]
  Tmux --> Codex[Codex CLI]
  API --> Browsers[Virtual browser profiles]
  Browsers --> Desktop[Local Chrome desktop]
  API --> Timers[Timers]
  Timers --> Threads
```

More detail: [docs/architecture.md](docs/architecture.md).

## What Is Included

- First-run setup at `/setup`
- OpenAI and Codex connection checks
- Docker image with Codex, tmux, git, ripgrep, and Chromium installed
- Multiple named Codex threads with start, sleep, wake, attach, and status controls
- Built-in local WhatsApp bridge with two QR-paired account slots
- WhatsApp chat creation and thread binding
- Thread-first runtime API for local Codex sessions
- Virtual browser registry, including a general-purpose virtual desktop
- Gmail OAuth surface
- LinkedIn and Gmail browser profiles
- Timers and manual timer runs
- Host/system doctor for runtime, browser, Codex, Caddy/Tailscale, and writable data paths
- CLI for listing, creating, waking, sleeping, sending to, and attaching threads
- Local activity logs and deterministic public demos

## Security Warning

Orkestr can wake local agents, pass text into terminal sessions, open browser profiles, and store connector credentials under `ORKESTR_HOME`.

Minimum safe defaults:

- Keep `ORKESTR_HOST=127.0.0.1`.
- Do not expose raw `/api/*`, thread streams, or terminal routes to the public internet.
- Use Tailscale plus Caddy/TLS before remote access.
- Keep real overlays, browser profiles, WhatsApp session state, Gmail tokens, and hostnames out of this public repo.
- Treat this alpha as single-user software.

See [SECURITY.md](SECURITY.md).

## Roadmap

Near-term launch work:

- Secure access onboarding: Caddy/Tailscale HTTPS checks and first-browser pairing.
- Better setup path naming and legacy `/ng/*` compatibility cleanup.
- A recorded end-to-end demo video using a real local Codex session.
- More complete browser desktop controls and status.
- Public examples for WhatsApp-to-thread routing and timers.

Full roadmap: [ROADMAP.md](ROADMAP.md).

## Contributing

Contributions are welcome while the project is still small. Start with:

```bash
npm run check
npm run demo:coding-agent
npm run launch:check
```

Public code must not include credentials, private hostnames, personal browser profiles, WhatsApp IDs, private prompts, or deployment-only paths. See [CONTRIBUTING.md](CONTRIBUTING.md) for the working rules.

## License

Orkestr is released under the MIT License. See [LICENSE](LICENSE).

## Public/Private Boundary

Generic product code belongs here. Personal deployment code belongs outside this repo and is loaded through `ORKESTR_OVERLAY_DIR`.

Examples of private-only material:

- real connector credentials
- real WhatsApp chat IDs
- browser profile state
- personal prompts and timers
- VPS hostnames
- host-specific Codex launch behavior

See [docs/private-overlay.md](docs/private-overlay.md).
