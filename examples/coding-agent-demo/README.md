# Coding Agent Demo

This is the public, real-agent demo path. No credentials, browser profiles,
WhatsApp IDs, or private hostnames are included here.

## Prerequisites

- A host-native Orkestr runtime with Node.js 22+ and tmux.
- Codex signed in from the Orkestr setup page.
- Orkestr running locally.

For a host-native development checkout:

```bash
./scripts/install.sh --local --serve
```

Then open `/setup`, add Codex, and use **Open Codex sign-in**.

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

Open `/setup`, add the virtual desktop, then prepare the desktop. The desktop profile lives under:

```text
ORKESTR_HOME/browsers/desktop
```

The browser profile is user-owned local state. Do not commit it.
