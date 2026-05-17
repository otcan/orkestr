# Coding Agent Demo

This is the public, real-agent demo path. The default Docker runtime includes
Codex and stores its auth under the Orkestr data volume. No credentials, browser
profiles, WhatsApp IDs, or private hostnames are included here.

## Prerequisites

- Docker with Compose, or a host-native Orkestr runtime with Node.js 22+ and tmux.
- Codex signed in from the Orkestr setup page.
- Orkestr running locally.

Start Orkestr with Docker:

```bash
cp .env.docker.example .env
docker compose up -d
```

Then open `/setup`, choose a Codex workflow, and use **Open Codex sign-in**.

For a host-native development checkout:

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

Wake the Codex session:

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
