# Coding Agent Demo

This is the public, real-agent demo path. It uses your local Codex CLI and a local repository checkout. No credentials, browser profiles, WhatsApp IDs, or private hostnames are included here.

## Prerequisites

- Node.js 22+
- `tmux`
- Codex CLI installed and logged in
- Orkestr running locally

Start Orkestr:

```bash
npm run build
ORKESTR_HOST=127.0.0.1 npm start
```

## Create A Coding Thread

From another terminal in this repository:

```bash
npx orkestr-oss thread create "Repo launch reviewer" \
  --id repo-launch-reviewer \
  --cwd "$PWD" \
  --executor codex
```

Wake the local Codex session:

```bash
npx orkestr-oss wake repo-launch-reviewer
```

Send a safe read-only task:

```bash
npx orkestr-oss send repo-launch-reviewer \
  "Inspect this repo and list the top five public-launch blockers. Do not edit files."
```

Attach to the terminal session:

```bash
npx orkestr-oss attach repo-launch-reviewer
```

## Optional Virtual Desktop Step

Open `/setup`, choose `Virtual Desktop Generation`, then prepare the desktop. The desktop profile lives under:

```text
ORKESTR_HOME/browsers/desktop
```

The browser profile is user-owned local state. Do not commit it.
