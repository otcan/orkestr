# Real Codex Coding Agent Walkthrough

This is the public real-agent walkthrough. It intentionally uses a real local
Codex runtime, so it requires Codex sign-in before the thread can run.

For the deterministic no-credential demo used by CI and local smoke checks, run
this from the repository root instead:

```bash
npm run demo:coding-agent
```

Expected result: `Coding-agent demo passed`. That deterministic demo uses a
temporary `ORKESTR_HOME`, a fake Codex app-server, no browser profiles, no
WhatsApp IDs, and no private hostnames.

## Prerequisites

- A host-native Orkestr runtime with Node.js 22+ and tmux.
- Codex signed in from the Orkestr setup page.
- Orkestr running locally.

For a host-native development checkout:

```bash
./scripts/install.sh --local --serve
```

Then open `/setup`, add Codex, and use **Open Codex sign-in**.

Expected result for this walkthrough: the `repo-launch-reviewer` thread wakes a
real Codex session, accepts the read-only prompt, and can be inspected with
`npx orkestr-oss attach repo-launch-reviewer`.

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
