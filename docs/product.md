# Product

## One-Line Pitch

Run a self-hosted Codex control center on your workstation or VPS, keep threads
alive, and control them from browser, phone, CLI, or WhatsApp.

## First User Journey

1. Install Orkestr.
2. Open `/setup`.
3. Connect Codex from the setup page with device authorization or an API key.
4. Pair WhatsApp 1 with the built-in local bridge.
5. Prepare the desktop profile.
6. Create the first coding thread.
7. Send a task from the web UI, CLI, or WhatsApp.
8. Inspect the Codex status, history, and activity log from the web cockpit.
9. Inspect the result and activity log.

Codex must pass `codex login status` before Orkestr wakes a coding thread. If
the runtime is not signed in, setup stays in `/setup/codex` rather than exposing
the raw Codex login menu inside a thread.
New coding threads are controlled through `codex app-server`. Older Orkestr
Codex threads must be migrated once with `orkestr codex migrate`; Orkestr does
not keep a tmux/Codex fallback path for Codex execution.

## Default Starter

The public starter is a coding-agent loop:

- one Orkestr thread maps to one local Codex runtime
- messages can be queued from the web UI, CLI, or WhatsApp
- existing Codex app-server threads can be imported from setup
- the virtual desktop profile is prepared for browser-based work
- timers can queue recurring work later

## Simplified OSS Surface

The OSS surface should stay narrow enough for a new user to understand and run:

- install locally or on a private VPS
- connect Codex
- create or import a persistent Codex thread
- send work from Web UI or CLI
- view status, history, approvals, and interruptions
- optionally add WhatsApp routing, timers, and a generic browser desktop

Managed/private operator features, production account bindings, aggregated
broker views, private tenant operations, and host-specific deployment automation
must not be required for this flow.

Run the deterministic public demo. This path uses a temporary `ORKESTR_HOME`
and a fake Codex app-server, so it does not require Codex sign-in or connector
credentials:

```bash
npm run demo:coding-agent
```

Expected result: `Coding-agent demo passed`, with a temporary
`demo-coding-agent` thread and one queued read-only task.

Run the real Codex example from a local or VPS host-native setup after Codex
sign-in:

```bash
npx orkestr-oss thread create "Repo launch reviewer" --id repo-launch-reviewer --cwd "$PWD" --executor codex
npx orkestr-oss wake repo-launch-reviewer
npx orkestr-oss send repo-launch-reviewer "Inspect this repo and list launch blockers. Do not edit files."
npx orkestr-oss attach repo-launch-reviewer
```

## V1 Boundaries

In:

- local setup
- public monorepo structure
- private overlay loading
- persistent connector config
- connector checks
- virtual browser profiles
- WhatsApp connector surface
- thread runtime records
- Codex CLI app-server runtime handoff
- one-time migration for older Orkestr Codex threads
- timers
- local activity events
- local host-native deployment
- host-native VPS deployment with systemd

Out:

- enterprise teams
- plugin marketplace
- Slack/Discord
- Kubernetes as a required install path
- multi-tenant hosting
- private host assumptions
