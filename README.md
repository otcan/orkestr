# Orkestr

Orkestr is a local-first workstation for running coding agents from your own machine.

It gives a local Codex session a control plane: setup, WhatsApp routing, virtual browser desktops, timers, logs, and a small web cockpit. It is designed for personal infrastructure first, not hosted multi-user SaaS.

> Public alpha. Do not expose Orkestr directly to the public internet. Keep it bound to `127.0.0.1` unless you have put it behind a trusted private network, TLS, and an auth boundary.

![Orkestr demo storyboard](docs/assets/orkestr-demo.gif)

## Why This Exists

Coding agents are useful, but the useful work usually lives outside the chat window:

- a repository on disk
- a browser profile with user-owned login state
- a WhatsApp thread where the user actually gives instructions
- recurring tasks that should run without reopening an IDE
- logs that explain what happened after the agent wakes up

Orkestr makes those pieces explicit. The default target is a single developer running local agents on a laptop, workstation, or private VPS.

## Quickstart

One-command install from a shell:

```bash
curl -fsSL https://raw.githubusercontent.com/orkestr/orkestr-oss/main/scripts/install.sh | bash
```

Local clone flow:

```bash
git clone https://github.com/orkestr/orkestr-oss.git
cd orkestr-oss
./scripts/install.sh --local --serve
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

For a real local Codex run, see [examples/coding-agent-demo/README.md](examples/coding-agent-demo/README.md).

Optional real Codex demo mode:

```bash
node scripts/coding-agent-demo.mjs --real-codex --repo "$PWD"
```

Regenerate the README demo asset:

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
- Built-in local WhatsApp bridge with two QR-paired account slots
- Thread-first runtime API for local Codex sessions
- Virtual browser registry, including a general-purpose virtual desktop
- Gmail OAuth surface
- LinkedIn and Gmail browser profiles
- Timers and manual timer runs
- CLI for listing, creating, waking, sending to, and attaching threads
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
